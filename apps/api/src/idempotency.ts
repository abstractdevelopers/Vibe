import type { Db } from "./db.js";
import { ApiError } from "./errors.js";
import { queryOne } from "./db.js";
import { hmacHex } from "./ids.js";

/**
 * Idempotency for non-repeatable writes. A caller sends an Idempotency-Key
 * header; the first request stores its response, and a replay with the same
 * key and body returns the stored response instead of repeating the write.
 */
export interface IdempotencyResult<T> {
  replayed: boolean;
  statusCode: number;
  body: T;
}

export async function runIdempotent<T>(
  db: Db,
  params: { userId: string; route: string; key: string; requestBody: unknown },
  handler: () => Promise<{ statusCode: number; body: T }>,
): Promise<IdempotencyResult<T>> {
  const requestHash = hmacHex("idempotency", JSON.stringify(params.requestBody ?? null));
  const existing = await queryOne<{ request_hash: string; response: T; status_code: number }>(
    db,
    `SELECT request_hash, response, status_code FROM idempotency_keys
      WHERE user_id = $1 AND route = $2 AND key = $3`,
    [params.userId, params.route, params.key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(
        "idempotency_conflict",
        "This Idempotency-Key was already used with a different request body",
      );
    }
    return { replayed: true, statusCode: existing.status_code, body: existing.response };
  }

  const { statusCode, body } = await handler();
  await db.query(
    `INSERT INTO idempotency_keys (user_id, route, key, request_hash, response, status_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, route, key) DO NOTHING`,
    [params.userId, params.route, params.key, requestHash, JSON.stringify(body), statusCode],
  );
  return { replayed: false, statusCode, body };
}

export function requireIdempotencyKey(header: string | undefined): string {
  const key = header?.trim();
  if (!key) {
    throw ApiError.badRequest("An Idempotency-Key header is required for this request");
  }
  return key;
}
