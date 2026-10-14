import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { queryMany, queryOne } from "../db.js";
import { ApiError } from "../errors.js";
import { parse, publicUser, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Direct messaging.
 *
 * A conversation is readable and writable only by its members; every route
 * checks membership server-side. Sending is idempotent on a client-generated
 * id, so a retry after a dropped response cannot post the message twice.
 *
 * Realtime only signals that something changed. The durable message lives in
 * Postgres, and the client re-reads over HTTP, so a missed socket event never
 * loses a message.
 */

const startSchema = z.object({
  userId: z.string().uuid().optional(),
  userIds: z.array(z.string().uuid()).min(1).max(50).optional(),
  title: z.string().max(120).optional(),
});

const messageSchema = z.object({
  clientId: z.string().min(1).max(80).optional(),
  body: z.string().max(4000).optional(),
  mediaUrls: z.array(z.string().max(500)).max(4).optional(),
});

const mediaUrl = z
  .string()
  .max(500)
  .refine((v) => /^https?:\/\//.test(v) || /^\/v1\/media\/[A-Za-z0-9._-]+$/.test(v), {
    message: "Media must be an https URL or a Vibe media path",
  });

/** Is the pair blocked in either direction? Blocking stops all messaging. */
async function blockedBetween(ctx: AppContext, a: string, b: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    ctx.pool,
    `SELECT EXISTS (
       SELECT 1 FROM blocks
        WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)
     ) AS exists`,
    [a, b],
  );
  return row?.exists ?? false;
}

async function requireMember(ctx: AppContext, conversationId: string, userId: string): Promise<void> {
  const row = await queryOne<{ user_id: string }>(
    ctx.pool,
    "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id = $2",
    [conversationId, userId],
  );
  if (!row) throw ApiError.forbidden("You are not part of this conversation");
}

/** A stable key for an unordered pair, so a DM is unique whichever side starts it. */
function directKey(a: string, b: string): string {
  return [a, b].sort().join(":");
}

export function messagingRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/v1/conversations", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.id, c.kind, c.title, c.last_message_at,
                m.last_read_at,
                (SELECT count(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS member_count,
                (SELECT count(*) FROM messages msg
                   WHERE msg.conversation_id = c.id
                     AND msg.deleted_at IS NULL
                     AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at)
                     AND msg.sender_id <> $1) AS unread_count,
                lm.body AS last_body,
                lm.media_urls AS last_media,
                lm.created_at AS last_message_created,
                lu.handle AS last_sender_handle,
                lu.display_name AS last_sender_name
           FROM conversation_members m
           JOIN conversations c ON c.id = m.conversation_id
           LEFT JOIN LATERAL (
             SELECT body, media_urls, created_at, sender_id
               FROM messages
              WHERE conversation_id = c.id AND deleted_at IS NULL
              ORDER BY created_at DESC, id DESC LIMIT 1
           ) lm ON true
           LEFT JOIN users lu ON lu.id = lm.sender_id
          WHERE m.user_id = $1
          ORDER BY c.last_message_at DESC
          LIMIT 100`,
        [user.id],
      );

      // For a direct conversation, show the other person's identity.
      const ids = rows.map((r) => r.id as string);
      const others = ids.length
        ? await queryMany(
            ctx.pool,
            `SELECT cm.conversation_id, u.id, u.handle, u.display_name, u.avatar_url, u.bio
               FROM conversation_members cm
               JOIN users u ON u.id = cm.user_id
              WHERE cm.conversation_id = ANY($1::uuid[]) AND cm.user_id <> $2`,
            [ids, user.id],
          )
        : [];
      const byConversation = new Map<string, ReturnType<typeof publicUser>[]>();
      for (const row of others) {
        const list = byConversation.get(row.conversation_id as string) ?? [];
        list.push(publicUser(row as never));
        byConversation.set(row.conversation_id as string, list);
      }

      return {
        conversations: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          memberCount: Number(row.member_count ?? 0),
          unreadCount: Number(row.unread_count ?? 0),
          lastMessageAt: row.last_message_at,
          lastReadAt: row.last_read_at,
          lastMessage: row.last_message_created
            ? {
                body: row.last_body,
                mediaUrls: row.last_media ?? [],
                createdAt: row.last_message_created,
                senderHandle: row.last_sender_handle,
                senderName: row.last_sender_name,
              }
            : null,
          participants: byConversation.get(row.id as string) ?? [],
        })),
      };
    });

    /** Start (or return) a direct conversation with one other person. */
    app.post("/v1/conversations", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(startSchema, req.body);
      const others = input.userIds ?? (input.userId ? [input.userId] : []);
      if (others.length === 0) throw ApiError.badRequest("Choose someone to message");
      if (others.includes(user.id) && others.length === 1) {
        throw ApiError.badRequest("You cannot message yourself");
      }

      const kind = others.length === 1 ? "direct" : "group";

      for (const otherId of others) {
        const exists = await queryOne(ctx.pool, "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [
          otherId,
        ]);
        if (!exists) throw ApiError.notFound("That person no longer exists");
        if (await blockedBetween(ctx, user.id, otherId)) {
          throw ApiError.forbidden("You cannot message this person");
        }
      }

      if (kind === "direct") {
        const key = directKey(user.id, others[0]!);
        const existing = await queryOne<{ id: string }>(
          ctx.pool,
          "SELECT id FROM conversations WHERE direct_key = $1",
          [key],
        );
        if (existing) {
          reply.code(200);
          return { id: existing.id, kind: "direct" };
        }
        const created = await queryOne<{ id: string }>(
          ctx.pool,
          "INSERT INTO conversations (kind, created_by, direct_key) VALUES ('direct', $1, $2) RETURNING id",
          [user.id, key],
        );
        const conversationId = created!.id;
        await ctx.pool.query(
          `INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
           VALUES ($1, $2, now()), ($1, $3, NULL)`,
          [conversationId, user.id, others[0]!],
        );
        reply.code(201);
        return { id: conversationId, kind: "direct" };
      }

      const created = await queryOne<{ id: string }>(
        ctx.pool,
        "INSERT INTO conversations (kind, title, created_by) VALUES ('group', $1, $2) RETURNING id",
        [input.title ?? null, user.id],
      );
      const conversationId = created!.id;
      const memberIds = Array.from(new Set([user.id, ...others]));
      await ctx.pool.query(
        `INSERT INTO conversation_members (conversation_id, user_id, last_read_at)
         SELECT $1, unnest($2::uuid[]), CASE WHEN unnest($2::uuid[]) = $3 THEN now() ELSE NULL END`,
        [conversationId, memberIds, user.id],
      );
      reply.code(201);
      return { id: conversationId, kind: "group" };
    });

    app.get("/v1/conversations/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requireMember(ctx, id, user.id);

      const conversation = await queryOne(
        ctx.pool,
        "SELECT id, kind, title, created_by, created_at, last_message_at FROM conversations WHERE id = $1",
        [id],
      );
      if (!conversation) throw ApiError.notFound("Conversation not found");

      const members = await queryMany(
        ctx.pool,
        `SELECT u.id, u.handle, u.display_name, u.avatar_url, u.bio, cm.last_read_at
           FROM conversation_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = $1`,
        [id],
      );

      return {
        conversation: {
          id: conversation.id,
          kind: conversation.kind,
          title: conversation.title,
          createdBy: conversation.created_by,
          createdAt: conversation.created_at,
          lastMessageAt: conversation.last_message_at,
        },
        members: members.map((m) => ({ ...publicUser(m as never), lastReadAt: m.last_read_at })),
      };
    });

    app.get("/v1/conversations/:id/messages", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requireMember(ctx, id, user.id);
      const { cursor, limit } = req.query as { cursor?: string; limit?: string };
      const take = Math.min(Number(limit) || 30, 100);

      // Cursor pagination newest-first, stable on (created_at, id).
      const params: unknown[] = [id, take + 1];
      let where = "";
      if (cursor) {
        const decoded = Buffer.from(cursor, "base64").toString("utf8");
        const [ts, msgId] = decoded.split("|");
        if (ts && msgId) {
          params.push(ts, msgId);
          where = `AND (msg.created_at, msg.id) < ($3::timestamptz, $4::uuid)`;
        }
      }

      const rows = await queryMany(
        ctx.pool,
        `SELECT msg.id, msg.sender_id, msg.client_id, msg.body, msg.media_urls, msg.created_at,
                msg.edited_at, msg.deleted_at, u.handle, u.display_name, u.avatar_url
           FROM messages msg JOIN users u ON u.id = msg.sender_id
          WHERE msg.conversation_id = $1 ${where}
          ORDER BY msg.created_at DESC, msg.id DESC
          LIMIT $2`,
        params,
      );

      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      const last = page[page.length - 1];
      const nextCursor =
        hasMore && last ? Buffer.from(`${new Date(last.created_at as Date).toISOString()}|${last.id}`).toString("base64") : null;

      return {
        messages: page.map((row) => ({
          id: row.id,
          clientId: row.client_id,
          senderId: row.sender_id,
          body: row.deleted_at ? null : row.body,
          mediaUrls: row.deleted_at ? [] : row.media_urls ?? [],
          deleted: Boolean(row.deleted_at),
          editedAt: row.edited_at,
          createdAt: row.created_at,
          author: publicUser(row as never),
        })),
        nextCursor,
      };
    });

    app.post("/v1/conversations/:id/messages", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requireMember(ctx, id, user.id);
      const input = parse(messageSchema, req.body);

      const mediaUrls = (input.mediaUrls ?? []).map((u) => {
        const parsed = mediaUrl.safeParse(u);
        if (!parsed.success) throw ApiError.badRequest("Media must be an https URL or a Vibe media path");
        return parsed.data;
      });

      if (!input.body?.trim() && mediaUrls.length === 0) {
        throw ApiError.badRequest("A message needs text or a photo");
      }

      // Blocking stops delivery in either direction, checked at send time.
      const others = await queryMany<{ user_id: string }>(
        ctx.pool,
        "SELECT user_id FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2",
        [id, user.id],
      );
      for (const other of others) {
        if (await blockedBetween(ctx, user.id, other.user_id)) {
          throw ApiError.forbidden("You cannot message this person");
        }
      }

      const inserted = await queryOne<{ id: string; created_at: Date }>(
        ctx.pool,
        `INSERT INTO messages (conversation_id, sender_id, client_id, body, media_urls)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (conversation_id, sender_id, client_id) WHERE client_id IS NOT NULL
         DO UPDATE SET body = messages.body
         RETURNING id, created_at`,
        [id, user.id, input.clientId ?? null, input.body?.trim() || null, mediaUrls],
      );

      await ctx.pool.query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [id]);
      await ctx.pool.query(
        "UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2",
        [id, user.id],
      );

      ctx.hub.publishToUsers(
        [user.id, ...others.map((o) => o.user_id)],
        { type: "message.created", entityId: id, payload: { conversationId: id, messageId: inserted!.id } },
      );

      trackSafe(ctx.pool, { name: "circle_message_sent", userId: user.id, properties: { entityType: "conversation", entityId: id } });
      reply.code(201);
      return { id: inserted!.id, createdAt: inserted!.created_at };
    });

    /** Mark a conversation read up to now. */
    app.post("/v1/conversations/:id/read", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await requireMember(ctx, id, user.id);
      await ctx.pool.query(
        "UPDATE conversation_members SET last_read_at = now() WHERE conversation_id = $1 AND user_id = $2",
        [id, user.id],
      );
      reply.code(204);
      return null;
    });

    app.post("/v1/conversations/:id/messages/:messageId/delete", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, messageId } = req.params as { id: string; messageId: string };
      await requireMember(ctx, id, user.id);
      const message = await queryOne<{ sender_id: string }>(
        ctx.pool,
        "SELECT sender_id FROM messages WHERE id = $1 AND conversation_id = $2",
        [messageId, id],
      );
      if (!message) throw ApiError.notFound("Message not found");
      if (message.sender_id !== user.id) throw ApiError.forbidden("You can only delete your own message");
      await ctx.pool.query("UPDATE messages SET deleted_at = now(), body = NULL, media_urls = '{}' WHERE id = $1", [
        messageId,
      ]);
      return { ok: true };
    });

    app.get("/v1/messaging/unread-count", async (req) => {
      const user = await requireUser(ctx, req);
      const row = await queryOne<{ count: number }>(
        ctx.pool,
        `SELECT COALESCE(sum(
             (SELECT count(*) FROM messages msg
               WHERE msg.conversation_id = c.id
                 AND msg.deleted_at IS NULL
                 AND (m.last_read_at IS NULL OR msg.created_at > m.last_read_at)
                 AND msg.sender_id <> $1)
           ), 0)::int AS count
           FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id
          WHERE m.user_id = $1`,
        [user.id],
      );
      return { unread: Number(row?.count ?? 0) };
    });
  };
}
