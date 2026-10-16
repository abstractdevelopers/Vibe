import { randomUUID, randomBytes, createHmac, createHash, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** URL-safe random token for invites, check-in codes and similar secrets. */
export function newToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** SHA-256 hex. Used to store secrets (session tokens, check-in codes) at rest. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}
