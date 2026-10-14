import type { FastifyRequest } from "fastify";
import type pg from "pg";
import type { ZodTypeAny, z } from "zod";
import { ApiError } from "./errors.js";
import { bearerToken, resolveSession, requireAdmin, type AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import type { RealtimeHub } from "./realtime.js";
import type { PaymentProvider } from "./payments/provider.js";

export interface AppContext {
  pool: pg.Pool;
  config: Config;
  hub: RealtimeHub;
  provider: PaymentProvider;
}

export interface UserLike {
  id: string;
  handle: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
}

export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<AuthUser | null> {
  const token = bearerToken(req.headers.authorization);
  if (!token) return null;
  return resolveSession(ctx.pool, token);
}

export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<AuthUser> {
  const user = await authenticate(ctx, req);
  if (!user) throw ApiError.unauthorized();
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
  };
}

export { requireAdmin };
