import type pg from "pg";

/**
 * Rate limiting.
 *
 * The deployment target is a single server running one application instance, so
 * a database-backed fixed-window counter is sufficient and adds no new moving
 * part. It is written as one atomic upsert, so two concurrent requests cannot
 * both read the old count and slip through together.
 *
 * If the deployment ever runs more than one instance, replace the body of
 * `hit` with a Redis counter behind this same interface; the routes do not
 * change.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Count one attempt against `bucket`. `limit` attempts are allowed per
 * `windowSeconds`; the window resets on the first hit after it has elapsed.
 */
export async function hit(
  pool: pg.Pool,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const { rows } = await pool.query<{ count: number; window_started_at: Date }>(
    `INSERT INTO rate_limit_counters (bucket, count, window_started_at)
     VALUES ($1, 1, now())
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE
         WHEN rate_limit_counters.window_started_at < now() - ($2 || ' seconds')::interval
         THEN 1
         ELSE rate_limit_counters.count + 1
       END,
       window_started_at = CASE
         WHEN rate_limit_counters.window_started_at < now() - ($2 || ' seconds')::interval
         THEN now()
         ELSE rate_limit_counters.window_started_at
       END
     RETURNING count, window_started_at`,
    [bucket, String(windowSeconds)],
  );
  const row = rows[0];
  if (!row) return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  const elapsed = (Date.now() - new Date(row.window_started_at).getTime()) / 1000;
  const retryAfterSeconds = Math.max(1, Math.ceil(windowSeconds - elapsed));
  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    retryAfterSeconds,
  };
}

/** Forget a bucket, e.g. after a successful login so a good user is not held back. */
export async function reset(pool: pg.Pool, bucket: string): Promise<void> {
  await pool.query(`DELETE FROM rate_limit_counters WHERE bucket = $1`, [bucket]);
}

/** Best-effort cleanup so the table does not grow without bound. */
export async function prune(pool: pg.Pool, olderThanSeconds = 3600): Promise<number> {
  const res = await pool.query(
    `DELETE FROM rate_limit_counters WHERE window_started_at < now() - ($1 || ' seconds')::interval`,
    [String(olderThanSeconds)],
  );
  return res.rowCount ?? 0;
}

/**
 * The client identity used for anonymous limits. `trustProxy` is on, so
 * `req.ip` is the real client address behind Coolify's proxy. Mobile carriers
 * put many users behind one NAT address, so IP is never the only signal — the
 * authenticated routes also bucket by user id.
 */
export function clientIp(ip: string | undefined): string {
  return ip && ip.length > 0 ? ip : "unknown";
}
