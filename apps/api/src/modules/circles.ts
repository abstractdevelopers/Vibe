import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { CircleRole } from "@vibe/shared";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId, newToken } from "../ids.js";
import { hashToken } from "../auth.js";
import { parse, publicUser, requireUser, type AppContext, type UserLike } from "../http.js";
import { circleIdsFor, requireCircleMember, requireCircleRole } from "./access.js";
import { trackSafe } from "./analytics.js";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  privacy: z.enum(["private", "invite_only", "public_discoverable"]).default("private"),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    privacy: z.enum(["private", "invite_only", "public_discoverable"]).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.privacy !== undefined, {
    message: "Nothing to update",
  });

const inviteSchema = z.object({
  role: z.enum(["admin", "moderator", "member"]).default("member"),
  expiresInHours: z.number().int().positive().max(24 * 90).optional(),
  maxUses: z.number().int().positive().max(500).optional(),
});

const memberUpdateSchema = z.object({
  role: z.enum(["owner", "admin", "moderator", "member"]),
});

/**
 * The circle's conversation, created on first use.
 *
 * A circle and its chat are one thing: the chat is where the circle talks and
 * where a plan or expense comes from. Rather than keep two membership lists in
 * step by hand, every member of the circle is made a member of the conversation
 * whenever the chat is touched (`syncCircleChat`). The conversation row is
 * created lazily so a circle that never opens its chat costs nothing.
 */
export async function ensureCircleConversation(
  pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> },
  circleId: string,
  createdBy: string,
): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    pool as never,
    "SELECT id FROM conversations WHERE circle_id = $1",
    [circleId],
  );
  if (existing) return existing.id;
  // Title the thread with the circle's name so the chat reads as the circle.
  const circle = await queryOne<{ name: string }>(
    pool as never,
    "SELECT name FROM circles WHERE id = $1",
    [circleId],
  );
  const created = await queryOne<{ id: string }>(
    pool as never,
    `INSERT INTO conversations (kind, title, created_by, circle_id)
     VALUES ('group', $3, $1, $2)
     ON CONFLICT (circle_id) WHERE circle_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [createdBy, circleId, circle?.name ?? "Circle chat"],
  );
  if (created) return created.id;
  // A concurrent create won the race; read the winner.
  const winner = await queryOne<{ id: string }>(
    pool as never,
    "SELECT id FROM conversations WHERE circle_id = $1",
    [circleId],
  );
  return winner!.id;
}

/** Make every circle member a member of the circle's conversation. */
export async function syncCircleChat(pool: { query: (t: string, p?: unknown[]) => Promise<unknown> }, circleId: string): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id)
     SELECT c.id, cm.user_id
       FROM conversations c
       JOIN circle_members cm ON cm.circle_id = c.circle_id
      WHERE c.circle_id = $1
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [circleId],
  );
}

/** Add one member to the circle's conversation, if the chat exists yet. */
export async function addMemberToCircleChat(
  pool: { query: (t: string, p?: unknown[]) => Promise<unknown> },
  circleId: string,
  userId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO conversation_members (conversation_id, user_id)
     SELECT id, $2 FROM conversations WHERE circle_id = $1
     ON CONFLICT (conversation_id, user_id) DO NOTHING`,
    [circleId, userId],
  );
}

/** Remove one member from the circle's conversation. */
export async function removeMemberFromCircleChat(
  pool: { query: (t: string, p?: unknown[]) => Promise<unknown> },
  circleId: string,
  userId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM conversation_members
      WHERE user_id = $2
        AND conversation_id IN (SELECT id FROM conversations WHERE circle_id = $1)`,
    [circleId, userId],
  );
}

export function circlesRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/circles", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createSchema, req.body);
      const circle = await withTransaction(ctx.pool, async (tx) => {
        const created = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO circles (id, name, description, privacy, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [newId(), input.name, input.description ?? null, input.privacy, user.id],
        );
        await tx.query(
          "INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, 'owner')",
          [created!.id, user.id],
        );
        await tx.query(
          `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
           VALUES ($1, 'circle.created', 'circle', $2)`,
          [user.id, created!.id],
        );
        return created!;
      });
      trackSafe(ctx.pool, { name: "circle_created", userId: user.id, properties: { entityType: "circle", entityId: circle.id } });
      reply.code(201);
      return { id: circle.id };
    });

    app.get("/v1/circles", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.id, c.name, c.description, c.privacy, cm.role,
                (SELECT count(*) FROM circle_members m WHERE m.circle_id = c.id) AS member_count
           FROM circles c
           JOIN circle_members cm ON cm.circle_id = c.id
          WHERE cm.user_id = $1 AND c.archived_at IS NULL
          ORDER BY c.created_at DESC`,
        [user.id],
      );
      return { circles: rows };
    });

    app.patch("/v1/circles/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      // Renaming or re-scoping a Circle is an admin act.
      await requireCircleRole(ctx.pool, id, user.id, "admin");
      const input = parse(updateSchema, req.body);
      const fields: string[] = [];
      const values: unknown[] = [];
      const set = (col: string, value: unknown) => {
        values.push(value);
        fields.push(`${col} = $${values.length}`);
      };
      if (input.name !== undefined) set("name", input.name);
      if (input.description !== undefined) set("description", input.description);
      if (input.privacy !== undefined) set("privacy", input.privacy);
      values.push(id);
      const updated = await queryOne<Record<string, unknown>>(
        ctx.pool,
        `UPDATE circles SET ${fields.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id, name, description, privacy`,
        values,
      );
      if (!updated) throw ApiError.notFound("Circle not found");
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'circle.updated', 'circle', $2, $3)`,
        [user.id, id, JSON.stringify(input)],
      );
      return { circle: updated };
    });

    app.delete("/v1/circles/:id", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      // Deleting a Circle is the owner's call, and only the owner's.
      await requireCircleRole(ctx.pool, id, user.id, "owner");
      // Soft-delete: `archived_at` hides the Circle from lists and detail, while
      // its plans, expenses and chat history stay intact for members. A hard
      // delete would cascade through those and lose shared records.
      const result = await ctx.pool.query(
        "UPDATE circles SET archived_at = now(), updated_at = now() WHERE id = $1 AND archived_at IS NULL",
        [id],
      );
      if (result.rowCount === 0) throw ApiError.notFound("Circle not found");
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id)
         VALUES ($1, 'circle.deleted', 'circle', $2)`,
        [user.id, id],
      );
      reply.code(204);
      return null;
    });

    app.get("/v1/circles/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const role = await requireCircleMember(ctx.pool, id, user.id);
      const circle = await queryOne<Record<string, unknown>>(
        ctx.pool,
        `SELECT id, name, description, privacy, created_by, created_at FROM circles
          WHERE id = $1 AND archived_at IS NULL`,
        [id],
      );
      if (!circle) throw ApiError.notFound("Circle not found");
      const members = await queryMany<UserLike & { role: string; joined_at: Date }>(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.bio, u.avatar_url, cm.role, cm.joined_at
           FROM circle_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.circle_id = $1 ORDER BY cm.joined_at`,
        [id],
      );
      const expenses = await queryMany(
        ctx.pool,
        `SELECT e.id, e.description, e.amount_minor, e.currency, e.split_mode, e.status,
                e.payer_id, e.created_at
           FROM expenses e WHERE e.circle_id = $1 ORDER BY e.created_at DESC LIMIT 20`,
        [id],
      );
      const plans = await queryMany(
        ctx.pool,
        `SELECT id, title, state, starts_at, timezone, place FROM plans
          WHERE circle_id = $1 ORDER BY starts_at LIMIT 20`,
        [id],
      );
      // Opening a circle opens its chat: create it if needed and make sure every
      // member is in it, then hand the client the conversation to open.
      const conversationId = await ensureCircleConversation(ctx.pool, id, user.id);
      await syncCircleChat(ctx.pool, id);
      return {
        circle,
        conversationId,
        viewerRole: role,
        members: members.map((m) => ({ ...publicUser(m), role: m.role, joinedAt: m.joined_at })),
        plans,
        expenses: expenses.map((e) => ({
          id: e.id,
          description: e.description,
          amountMinor: e.amount_minor,
          currency: e.currency,
          splitMode: e.split_mode,
          status: e.status,
          payerId: e.payer_id,
          createdAt: e.created_at,
        })),
      };
    });

    app.post("/v1/circles/:id/invites", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requireCircleRole(ctx.pool, id, user.id, "admin");
      const input = parse(inviteSchema, req.body);
      const token = newToken(24);
      const expiresAt = input.expiresInHours
        ? new Date(Date.now() + input.expiresInHours * 3600 * 1000)
        : null;
      await ctx.pool.query(
        `INSERT INTO circle_invites (id, circle_id, token_hash, role, created_by, expires_at, max_uses)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [newId(), id, hashToken(token), input.role, user.id, expiresAt, input.maxUses ?? null],
      );
      reply.code(201);
      trackSafe(ctx.pool, { name: "circle_invite_sent", userId: user.id, properties: { entityType: "circle", entityId: id } });
      // The raw token is returned once and never stored in the clear.
      return { inviteToken: token, expiresAt: expiresAt?.toISOString() ?? null, role: input.role };
    });

    /**
     * A public preview of an invite. This is what an invite link resolves to
     * before the visitor has an account, so the landing page can name the
     * Circle instead of showing a dead link. It reveals only the Circle's
     * public face — never its members or posts.
     */
    app.get("/v1/invites/:token", async (req) => {
      const { token } = req.params as { token: string };
      const invite = await queryOne<{
        circle_id: string; role: CircleRole; expires_at: Date | null;
        max_uses: number | null; uses: number; revoked_at: Date | null;
        name: string; description: string | null; privacy: string;
      }>(
        ctx.pool,
        `SELECT i.circle_id, i.role, i.expires_at, i.max_uses, i.uses, i.revoked_at,
                c.name, c.description, c.privacy
           FROM circle_invites i JOIN circles c ON c.id = i.circle_id
          WHERE i.token_hash = $1`,
        [hashToken(token)],
      );
      if (!invite) throw ApiError.notFound("Invite not found");
      const expired = invite.expires_at !== null && invite.expires_at.getTime() <= Date.now();
      const exhausted = invite.max_uses !== null && invite.uses >= invite.max_uses;
      return {
        circle: {
          id: invite.circle_id,
          name: invite.name,
          description: invite.description,
          privacy: invite.privacy,
        },
        role: invite.role,
        usable: !invite.revoked_at && !expired && !exhausted,
        reason: invite.revoked_at ? "revoked" : expired ? "expired" : exhausted ? "used_up" : null,
      };
    });

    app.post("/v1/invites/:token/accept", async (req) => {
      const user = await requireUser(ctx, req);
      const { token } = req.params as { token: string };
      const invite = await queryOne<{
        id: string;
        circle_id: string;
        role: CircleRole;
        expires_at: Date | null;
        max_uses: number | null;
        uses: number;
        revoked_at: Date | null;
      }>(
        ctx.pool,
        `SELECT id, circle_id, role, expires_at, max_uses, uses, revoked_at
           FROM circle_invites WHERE token_hash = $1`,
        [hashToken(token)],
      );
      if (!invite) throw ApiError.notFound("Invite not found");
      if (invite.revoked_at) throw ApiError.forbidden("This invite has been revoked");
      if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) {
        throw ApiError.forbidden("This invite has expired");
      }
      if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
        throw ApiError.forbidden("This invite has reached its usage limit");
      }
      const alreadyMember = await queryOne(
        ctx.pool,
        "SELECT 1 FROM circle_members WHERE circle_id = $1 AND user_id = $2",
        [invite.circle_id, user.id],
      );
      if (alreadyMember) return { circleId: invite.circle_id, role: invite.role, alreadyMember: true };
      await withTransaction(ctx.pool, async (tx) => {
        // Claim a use atomically. Checking `uses` outside the transaction and
        // incrementing unconditionally inside let two accepts both pass the
        // check and take one invite past its limit.
        const claimed = await tx.query(
          `UPDATE circle_invites SET uses = uses + 1
            WHERE id = $1
              AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > now())
              AND (max_uses IS NULL OR uses < max_uses)
            RETURNING id`,
          [invite.id],
        );
        if ((claimed.rowCount ?? 0) === 0) {
          throw ApiError.forbidden("This invite has reached its usage limit");
        }
        await tx.query(
          `INSERT INTO circle_members (circle_id, user_id, role) VALUES ($1, $2, $3)
           ON CONFLICT (circle_id, user_id) DO NOTHING`,
          [invite.circle_id, user.id, invite.role],
        );
      });
      // If the circle already has a chat, the new member joins it.
      await addMemberToCircleChat(ctx.pool, invite.circle_id, user.id);
      trackSafe(ctx.pool, { name: "circle_invite_accepted", userId: user.id, properties: { entityType: "circle", entityId: invite.circle_id } });
      return { circleId: invite.circle_id, role: invite.role };
    });

    app.patch("/v1/circles/:id/members/:userId", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, userId } = req.params as { id: string; userId: string };
      const actorRole = await requireCircleRole(ctx.pool, id, user.id, "admin");
      const input = parse(memberUpdateSchema, req.body);
      const targetRole = await requireCircleMember(ctx.pool, id, userId);
      // Only the owner can mint another owner, and the owner cannot be demoted here.
      if (input.role === "owner" && actorRole !== "owner") {
        throw ApiError.forbidden("Only the owner can transfer ownership");
      }
      if (targetRole === "owner") {
        throw ApiError.forbidden("Transfer ownership instead of changing the owner's role");
      }
      await ctx.pool.query("UPDATE circle_members SET role = $1 WHERE circle_id = $2 AND user_id = $3", [
        input.role,
        id,
        userId,
      ]);
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'circle.member_role_changed', 'circle', $2, $3)`,
        [user.id, id, JSON.stringify({ userId, role: input.role })],
      );
      return { ok: true };
    });

    app.delete("/v1/circles/:id/members/:userId", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, userId } = req.params as { id: string; userId: string };
      await requireCircleRole(ctx.pool, id, user.id, "admin");
      const targetRole = await requireCircleMember(ctx.pool, id, userId);
      if (targetRole === "owner") throw ApiError.forbidden("The owner cannot be removed");
      await ctx.pool.query("DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2", [id, userId]);
      // Removal from the circle is removal from its chat.
      await removeMemberFromCircleChat(ctx.pool, id, userId);
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, 'circle.member_removed', 'circle', $2, $3)`,
        [user.id, id, JSON.stringify({ userId })],
      );
      return { ok: true };
    });

    // Members can always leave; expense records remain visible to participants.
    app.post("/v1/circles/:id/leave", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const role = await requireCircleMember(ctx.pool, id, user.id);
      if (role === "owner") {
        throw ApiError.conflict("Transfer ownership before leaving this Circle");
      }
      await ctx.pool.query("DELETE FROM circle_members WHERE circle_id = $1 AND user_id = $2", [id, user.id]);
      await removeMemberFromCircleChat(ctx.pool, id, user.id);
      reply.code(204);
      return null;
    });

    app.get("/v1/realtime/circles", async (req) => {
      const user = await requireUser(ctx, req);
      return { circleIds: await circleIdsFor(ctx.pool, user.id) };
    });
  };
}
