import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { ZodTypeAny, z } from "zod";
import { ApiError } from "./errors.js";
import { bearerToken, resolveSession, requireAdmin, type AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import type { RealtimeHub } from "./realtime.js";
import type { PaymentProvider } from "./payments/provider.js";
import type { PayoutProvider } from "./payments/payouts.js";
import type { Mailer } from "./modules/mailer.js";

export interface AppContext {
  pool: pg.Pool;
  config: Config;
  hub: RealtimeHub;
  provider: PaymentProvider;
  payouts: PayoutProvider;
  mailer: Mailer;
}

export interface UserLike {
  id: string;
  handle: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  host_kind?: string | null;
  host_disclosure?: string | null;
}

export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<AuthUser | null> {
  const token = bearerToken(req.headers.authorization);
  if (!token) return null;
  return resolveSession(ctx.pool, token);
}

export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  const user = await authenticate(ctx, req);
  if (!user) throw ApiError.unauthorized();
  // A suspended or banned account cannot act, even with a live session. A
  // time-boxed suspension has already been lazily lifted by `resolveSession`
  // once its end date passed.
  if (user.moderationStatus === "banned") {
    throw ApiError.forbidden("This account has been banned");
  }
  if (user.moderationStatus === "suspended" && (!user.moderationUntil || user.moderationUntil.getTime() > Date.now())) {
    throw ApiError.forbidden("This account is suspended");
  }
  return user;
}

/** Validate a body against a zod schema, raising a field-error envelope on failure. */
export function parse<T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const fieldErrors = result.error.issues.map((issue) => ({
      field: issue.path.join(".") || "(root)",
      message: issue.message,
    }));
    throw new ApiError("validation_error", "Request validation failed", fieldErrors);
  }
  return result.data;
}

export function publicUser(row: UserLike) {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio ?? null,
    avatarUrl: row.avatar_url ?? null,
    // Always tell the client whether this account is a real person or an
    // official/automated host. There is no way to hide it.
    hostKind: row.host_kind ?? "person",
    hostDisclosure: row.host_disclosure ?? null,
  };
}

export { requireAdmin };
