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
}

interface UserRow {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  is_admin: boolean;
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

export async function resolveSession(db: Db, token: string): Promise<AuthUser | null> {
  const row = await queryOne<UserRow & { expires_at: Date; revoked_at: Date | null }>(
    db,
    `SELECT u.id, u.email, u.handle, u.display_name, u.is_admin, s.expires_at, s.revoked_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.revoked_at || row.expires_at.getTime() <= Date.now()) return null;
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.display_name,
    isAdmin: row.is_admin,
  };
}

export async function revokeSession(db: Db, token: string): Promise<void> {
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
