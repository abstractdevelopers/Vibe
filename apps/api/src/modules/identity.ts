import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import {
  createSession,
  hashPassword,
  revokeSession,
  verifyPassword,
  bearerToken,
} from "../auth.js";
import { queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";

const registerSchema = z.object({
  email: z.string().email().max(254),
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Handle may contain letters, digits and underscore only"),
  displayName: z.string().min(1).max(60),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const privacySchema = z.object({
  discoverable: z.boolean().optional(),
  profileAudience: z.enum(["public", "connections", "private"]).optional(),
  activityVisibility: z.enum(["public", "connections", "private"]).optional(),
  readReceipts: z.boolean().optional(),
  locationEnabled: z.boolean().optional(),
  contactsSyncEnabled: z.boolean().optional(),
});

const profileSchema = z.object({
  displayName: z.string().min(1).max(60).optional(),
  handle: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/, "Handle may contain letters, digits and underscore only")
    .optional(),
  bio: z.string().max(280).nullable().optional(),
  avatarUrl: z.string().url().max(1000).nullable().optional(),
  interests: z.array(z.string().min(1).max(40)).max(20).optional(),
  city: z.string().max(80).nullable().optional(),
  area: z.string().max(80).nullable().optional(),
});

interface UserRow {
  id: string;
  email: string;
  handle: string;
  display_name: string;
  bio: string | null;
  avatar_url: string | null;
  is_admin: boolean;
}

export function identityRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/auth/register", async (req, reply) => {
      const input = parse(registerSchema, req.body);
      const passwordHash = await hashPassword(input.password);
      const user = await withTransaction(ctx.pool, async (tx) => {
        const clash = await queryOne<{ id: string }>(
          tx,
          "SELECT id FROM users WHERE lower(email) = lower($1) OR lower(handle) = lower($2)",
          [input.email, input.handle],
        );
        if (clash) throw ApiError.conflict("That email or handle is already in use");
        return queryOne<UserRow>(
          tx,
          `INSERT INTO users (id, email, handle, display_name, password_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, email, handle, display_name, bio, avatar_url, is_admin`,
          [newId(), input.email.toLowerCase(), input.handle, input.displayName, passwordHash],
        );
      });
      const session = await createSession(ctx.pool, user!.id, ctx.config.SESSION_TTL_SECONDS);
      reply.code(201);
      return {
        user: { ...publicUser(user!), email: user!.email },
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      };
    });

    app.post("/v1/auth/login", async (req) => {
      const input = parse(loginSchema, req.body);
      const row = await queryOne<UserRow & { password_hash: string }>(
        ctx.pool,
        `SELECT id, email, handle, display_name, bio, avatar_url, is_admin, password_hash
           FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
        [input.email],
      );
      const ok = row ? await verifyPassword(input.password, row.password_hash) : false;
      if (!row || !ok) throw ApiError.unauthorized("Invalid email or password");
      const session = await createSession(ctx.pool, row.id, ctx.config.SESSION_TTL_SECONDS);
      return {
        user: { ...publicUser(row), email: row.email },
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      };
    });

    app.post("/v1/auth/logout", async (req, reply) => {
      const token = bearerToken(req.headers.authorization);
      if (token) await revokeSession(ctx.pool, token);
      reply.code(204);
      return null;
    });

    app.get("/v1/me", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<UserRow & Record<string, unknown>>(
        ctx.pool,
        `SELECT id, email, handle, display_name, bio, avatar_url, is_admin, interests,
                city, area,
                discoverable, profile_audience, activity_visibility, read_receipts,
                location_enabled, contacts_sync_enabled
           FROM users WHERE id = $1`,
        [user.id],
      );
      return {
        ...publicUser(row!),
        email: row!.email,
        isAdmin: row!.is_admin,
        interests: (row!.interests as string[]) ?? [],
        city: (row!.city as string | null) ?? null,
        area: (row!.area as string | null) ?? null,
        privacy: {
          discoverable: row!.discoverable,
          profileAudience: row!.profile_audience,
          activityVisibility: row!.activity_visibility,
          readReceipts: row!.read_receipts,
          locationEnabled: row!.location_enabled,
          contactsSyncEnabled: row!.contacts_sync_enabled,
        },
      };
    });

    app.patch("/v1/me", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(profileSchema, req.body);
      const columns: Record<string, string> = {
        displayName: "display_name",
        handle: "handle",
        bio: "bio",
        avatarUrl: "avatar_url",
        interests: "interests",
        city: "city",
        area: "area",
      };
      const sets: string[] = [];
      const values: unknown[] = [user.id];
      for (const [key, column] of Object.entries(columns)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw ApiError.badRequest("Nothing to update");

      // Handles are the public identity, so a change must stay unique and
      // cannot be a case-only variant of someone else's handle.
      if (input.handle !== undefined) {
        const clash = await queryOne<{ id: string }>(
          ctx.pool,
          "SELECT id FROM users WHERE lower(handle) = lower($1) AND id <> $2",
          [input.handle, user.id],
        );
        if (clash) throw ApiError.conflict("That handle is taken");
      }

      sets.push("updated_at = now()");
      const updated = await queryOne<UserRow & Record<string, unknown>>(
        ctx.pool,
        `UPDATE users SET ${sets.join(", ")}
          WHERE id = $1
      RETURNING id, email, handle, display_name, bio, avatar_url, is_admin,
                city, area,
                discoverable, profile_audience, activity_visibility, read_receipts,
                location_enabled, contacts_sync_enabled, interests`,
        values,
      );
      return {
        ...publicUser(updated!),
        email: updated!.email,
        isAdmin: updated!.is_admin,
        interests: (updated!.interests as string[]) ?? [],
        city: (updated!.city as string | null) ?? null,
        area: (updated!.area as string | null) ?? null,
        privacy: {
          discoverable: updated!.discoverable,
          profileAudience: updated!.profile_audience,
          activityVisibility: updated!.activity_visibility,
          readReceipts: updated!.read_receipts,
          locationEnabled: updated!.location_enabled,
          contactsSyncEnabled: updated!.contacts_sync_enabled,
        },
      };
    });

    app.patch("/v1/me/privacy", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(privacySchema, req.body);
      const columns: Record<string, string> = {
        discoverable: "discoverable",
        profileAudience: "profile_audience",
        activityVisibility: "activity_visibility",
        readReceipts: "read_receipts",
        locationEnabled: "location_enabled",
        contactsSyncEnabled: "contacts_sync_enabled",
      };
      const sets: string[] = [];
      const values: unknown[] = [user.id];
      for (const [key, column] of Object.entries(columns)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (sets.length === 0) throw ApiError.badRequest("No privacy settings supplied");
      sets.push("updated_at = now()");
      await ctx.pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $1`, values);
      return { ok: true };
    });
  };
}
