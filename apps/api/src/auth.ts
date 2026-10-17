import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { newId, newToken } from "./ids.js";
import { queryOne } from "./db.js";

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

/** scrypt password hashing; format is scrypt$<saltHex>$<hashHex>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = (await scryptAsync(password, Buffer.from(saltHex, "hex"), KEYLEN)) as Buffer;
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface AuthUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  isAdmin: boolean;
  moderationStatus: "active" | "warned" | "restricted" | "suspended" | "banned";
}

interface UserRow {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  is_admin: boolean;
  moderation_status: AuthUser["moderationStatus"];
}

export async function createSession(
  db: Db,
  userId: string,
  ttlSeconds: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken(32);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  await db.query(
    "INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
    [newId(), userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

/**
 * Session lookup cache.
 *
 * Every authenticated request resolves its bearer token with a join against
 * `sessions`. At a hundred thousand concurrent users that join is the single
 * most-repeated query in the system, and it changes almost never. A short-lived
 * cache keyed by the token hash removes the vast majority of those reads.
 *
 * It is deliberately conservative: entries live a few seconds, only successful
 * lookups are cached, a revocation evicts immediately, and the cache is off in
 * tests so a truncated database cannot leave a stale identity behind.
 */
interface CachedSession { user: AuthUser; expiresAt: number }
const SESSION_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX = 50_000;
const sessionCache = new Map<string, CachedSession>();

/** Drop a cached identity. Called on logout so a revoked token stops working now. */
export function invalidateSession(token: string): void {
  sessionCache.delete(hashToken(token));
}

/** Clear the whole cache. Test-only. */
export function clearSessionCache(): void {
  sessionCache.clear();
}

export async function resolveSession(db: Db, token: string): Promise<AuthUser | null> {
  const key = hashToken(token);
  const cacheable = process.env.NODE_ENV !== "test";
  if (cacheable) {
    const hit = sessionCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.user;
    if (hit) sessionCache.delete(key);
  }
  const row = await queryOne<UserRow & { expires_at: Date; revoked_at: Date | null }>(
    db,
    `SELECT u.id, u.email, u.handle, u.display_name, u.is_admin, u.moderation_status,
            s.expires_at, s.revoked_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
    [key],
  );
  if (!row) return null;
  if (row.revoked_at || row.expires_at.getTime() <= Date.now()) return null;
  const user: AuthUser = {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.display_name,
    isAdmin: row.is_admin,
    moderationStatus: row.moderation_status,
  };
  if (cacheable) {
    if (sessionCache.size >= SESSION_CACHE_MAX) sessionCache.clear();
    sessionCache.set(key, { user, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  }
  return user;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  invalidateSession(token);
  await db.query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [hashToken(token)]);
}

export function requireAdmin(user: AuthUser): void {
  if (!user.isAdmin) throw ApiError.forbidden("Administrator access required");
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
