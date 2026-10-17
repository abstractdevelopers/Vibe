import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId, newToken } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireCircleMember } from "./access.js";
import { trackSafe } from "./analytics.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { splitGift } from "../money/catalogue.js";

/**
 * Immersive activities: Live Now, sports rooms, movie clubs, listening parties
 * and the viral loop around them (addendum §1–§5).
 *
 * Two rules drive most of the design here:
 *
 *   1. A room is never described as live unless it is. `state_override` only
 *      stores a terminal 'ended'/'cancelled'; the live/scheduled answer is
 *      derived from the clock in `effectiveRoomState`.
 *   2. Vibe coordinates; it does not retransmit. A movie or music room carries
 *      a link to a licensed service and states whether playback is actually
 *      synchronized or merely coordinated.
 */

/** A room counts as "starting soon" within this window before it opens. */
const SOON_MS = 30 * 60_000;

export type RoomState = "live" | "starting_soon" | "scheduled" | "ended" | "cancelled";

interface RoomRow {
  id: string;
  kind: string;
  title: string;
  topic: string | null;
  state_override: string | null;
  starts_at: Date;
  ends_at: Date;
  city: string | null;
  area: string | null;
  visibility: string;
  host_id: string;
  circle_id: string | null;
  data_source: string | null;
  data_source_url: string | null;
  external_url: string | null;
  playback_mode: string;
  spoiler_policy: string;
  rules: string | null;
  slow_mode_seconds: number;
  is_sponsored: boolean;
  sponsor_label: string | null;
  recurrence: string | null;
  audio_track: unknown;
  audio_started_at: Date | null;
  cohost_id: string | null;
  ticket_price_minor: string;
  banner_url: string | null;
  hype: number;
  host_handle?: string;
  host_name?: string;
  host_kind?: string;
  host_disclosure?: string | null;
  member_count?: number;
}

/**
 * The one place that decides whether a room is live. Everything else reads it,
 * so a room can never be labelled live by accident.
 */
export function effectiveRoomState(room: Pick<RoomRow, "state_override" | "starts_at" | "ends_at">, now = new Date()): RoomState {
  if (room.state_override === "cancelled") return "cancelled";
  if (room.state_override === "ended") return "ended";
  const start = new Date(room.starts_at).getTime();
  const end = new Date(room.ends_at).getTime();
  const t = now.getTime();
  if (t >= end) return "ended";
  if (t >= start) return "live";
  if (start - t <= SOON_MS) return "starting_soon";
  return "scheduled";
}

/** Serialize a room, always including the derived state and honest host label. */
function serializeRoom(room: RoomRow, now = new Date()) {
  return {
    id: room.id,
    kind: room.kind,
    title: room.title,
    topic: room.topic,
    state: effectiveRoomState(room, now),
    startsAt: room.starts_at,
    endsAt: room.ends_at,
    city: room.city,
    area: room.area,
    visibility: room.visibility,
    host: {
      id: room.host_id,
      handle: room.host_handle,
      displayName: room.host_name,
      // Never hide this. A client can always tell a person from an official or
      // automated host.
      kind: room.host_kind ?? "person",
      disclosure: room.host_disclosure ?? null,
    },
    circleId: room.circle_id,
    memberCount: room.member_count ?? 0,
    dataSource: room.data_source,
    dataSourceUrl: room.data_source_url,
    externalUrl: room.external_url,
    playbackMode: room.playback_mode,
    spoilerPolicy: room.spoiler_policy,
    rules: room.rules,
    slowModeSeconds: room.slow_mode_seconds,
    isSponsored: room.is_sponsored,
    sponsorLabel: room.sponsor_label,
    recurrence: room.recurrence,
    bannerUrl: room.banner_url,
    audioTrack: room.audio_track ?? null,
    audioStartedAt: room.audio_started_at,
    cohostId: room.cohost_id,
    // A room is paid when its ticket price is above zero. The client shows the
    // price; the server enforces it on join.
    ticketPriceMinor: Number(room.ticket_price_minor ?? 0),
    isTicketed: Number(room.ticket_price_minor ?? 0) > 0,
    // Energy: reactions and gifts in the last hour. Drives the live "hot" badge.
    hype: Number(room.hype ?? 0),
  };
}

/** The audience fee the platform keeps on a ticket, in basis points (30%). */
const TICKET_FEE_BPS = 3000;

const createRoomSchema = z.object({
  // voice = open audio stage; listen = music-forward listening room.
  kind: z.enum(["sports", "movie", "music", "other", "voice", "listen"]),
  title: z.string().min(1).max(160),
  topic: z.string().max(400).optional(),
  startsAt: z.coerce.date(),
  durationMinutes: z.coerce.number().int().min(5).max(1440).default(120),
  city: z.string().max(80).optional(),
  area: z.string().max(80).optional(),
  visibility: z.enum(["public", "private"]).default("public"),
  circleId: z.string().uuid().optional(),
  dataSource: z.string().max(120).optional(),
  dataSourceUrl: z.string().url().max(500).optional(),
  externalUrl: z.string().url().max(500).optional(),
  playbackMode: z.enum(["coordinated", "synchronized"]).default("coordinated"),
  spoilerPolicy: z.enum(["open", "spoiler_safe"]).default("open"),
  rules: z.string().max(2000).optional(),
  // A creator can go live on any day, including every day.
  recurrence: z.enum(["daily", "weekly", "fortnightly", "monthly"]).optional(),
  // Zero is free entry. Anything above zero is a paid ticket.
  ticketPriceMinor: z.coerce.number().int().min(0).max(100_000_000).default(0),
  currency: z.string().length(3).default("NGN"),
  bannerUrl: z.string().max(500).optional(),
  audioTrack: z
    .object({
      title: z.string().min(1).max(200),
      artist: z.string().max(200).optional(),
      url: z.string().url().max(500).optional(),
      artworkUrl: z.string().url().max(500).optional(),
    })
    .optional(),
});

/**
 * Rights and honesty gate. A synchronized movie/music room must point at a
 * licensed service, and any sports room that cites a score must cite a source.
 * This is where "do not fabricate live scores" and "do not rebroadcast" become
 * code rather than prose.
 */
function assertRoomHonest(input: z.infer<typeof createRoomSchema>): void {
  // A voice or listen room is hosted audio, not retransmitted media, so it is
  // exempt from the synchronized-service rule.
  if (input.playbackMode === "synchronized" && !input.externalUrl && input.kind !== "voice" && input.kind !== "listen") {
    throw ApiError.badRequest(
      "A synchronized room must link the licensed service it plays through; Vibe does not retransmit media.",
    );
  }
  if (input.kind === "sports" && input.dataSourceUrl && !input.dataSource) {
    throw ApiError.badRequest("Citing a data source requires naming it.");
  }
}

export function activityRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // ---- Discover: Live Now + upcoming, never lying about state ----
    app.get("/v1/activities/live", async (req) => {
      await requireUser(ctx, req);
      const q = parse(
        z.object({
          kind: z.enum(["sports", "movie", "music", "other"]).optional(),
          city: z.string().max(80).optional(),
          limit: z.coerce.number().int().min(1).max(50).default(20),
        }),
        req.query,
      );
      const rows = await queryMany<RoomRow>(
        ctx.pool,
        `${ROOM_SELECT}
          WHERE r.visibility = 'public'
            AND r.state_override IS NULL
            AND r.ends_at > now()
            AND ($1::text IS NULL OR r.kind = $1)
            AND ($2::text IS NULL OR lower(coalesce(r.city, '')) = lower($2))
          ORDER BY r.starts_at ASC
          LIMIT $3`,
        [q.kind ?? null, q.city ?? null, q.limit],
      );
      const now = new Date();
      // Live first, then starting soon, then scheduled — the client shows one
      // "Live Now" rail without inventing anything.
      const rank: Record<string, number> = { live: 0, starting_soon: 1, scheduled: 2 };
      const rooms = rows
        .map((r) => serializeRoom(r, now))
        .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
      return { rooms };
    });

    app.get("/v1/activities/rooms", async (req) => {
      await requireUser(ctx, req);
      const q = parse(
        z.object({ kind: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) }),
        req.query,
      );
      const rows = await queryMany<RoomRow>(
        ctx.pool,
        `${ROOM_SELECT}
          WHERE r.visibility = 'public' AND ($1::text IS NULL OR r.kind = $1)
          ORDER BY r.starts_at DESC LIMIT $2`,
        [q.kind ?? null, q.limit],
      );
      return { rooms: rows.map((r) => serializeRoom(r)) };
    });

    app.post("/v1/activities/rooms", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createRoomSchema, req.body);
      assertRoomHonest(input);
      if (input.circleId) await requireCircleMember(ctx.pool, input.circleId, user.id);
      const startsAt = input.startsAt;
      const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);
      const id = newId();
      await withTransaction(ctx.pool, async (client) => {
        await client.query(
          `INSERT INTO activity_rooms
             (id, kind, title, topic, starts_at, ends_at, city, area, visibility, host_id,
              circle_id, data_source, data_source_url, external_url, playback_mode,
              spoiler_policy, rules, recurrence, ticket_price_minor, banner_url, audio_track)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            id, input.kind, input.title, input.topic ?? null, startsAt, endsAt,
            input.city ?? null, input.area ?? null, input.visibility, user.id,
            input.circleId ?? null, input.dataSource ?? null, input.dataSourceUrl ?? null,
            input.externalUrl ?? null, input.playbackMode, input.spoilerPolicy,
            input.rules ?? null, input.recurrence ?? null,
            input.ticketPriceMinor, input.bannerUrl ?? null,
            input.audioTrack ? JSON.stringify(input.audioTrack) : null,
          ],
        );
        await client.query(
          `INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'host')`,
          [id, user.id],
        );
      });
      trackSafe(ctx.pool, { name: "activity_created", userId: user.id, properties: { kind: input.kind, entityType: "room", entityId: id } });
      reply.code(201);
      return { room: await loadRoom(ctx, id, user.id) };
    });

    app.get("/v1/activities/rooms/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const room = await loadRoom(ctx, id, user.id);
      if (!room) throw ApiError.notFound("Room not found");
      return { room };
    });

    // ---- Preview: what a share link shows before anyone signs up ----
    app.get("/v1/activities/preview/:token", async (req) => {
      const { token } = req.params as { token: string };
      const link = await queryOne<{ room_id: string; revoked_at: Date | null }>(
        ctx.pool,
        `SELECT room_id, revoked_at FROM activity_links WHERE token = $1`,
        [token],
      );
      if (!link || link.revoked_at) throw ApiError.notFound("This link is no longer available");
      const room = await loadRoom(ctx, link.room_id, null);
      if (!room) throw ApiError.notFound("Room not found");
      // A private room exposes only enough to be useful: title, kind, host
      // label and when it starts. Never its conversation.
      return {
        preview: {
          roomId: room.id,
          kind: room.kind,
          title: room.title,
          topic: room.topic,
          state: room.state,
          startsAt: room.startsAt,
          host: room.host,
          visibility: room.visibility,
          requiresSignup: true,
        },
      };
    });

    // ---- Join / leave ----
    app.post("/v1/activities/rooms/:id/join", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const room = await loadRoom(ctx, id, user.id);
      if (!room) throw ApiError.notFound("Room not found");
      // A ticketed room needs a granted ticket first. A host is always allowed
      // in. Entry is a grant, never a balance.
      if (room.isTicketed && room.host.id !== user.id) {
        const ticket = await queryOne<{ status: string }>(
          ctx.pool,
          "SELECT status FROM room_tickets WHERE room_id = $1 AND user_id = $2",
          [id, user.id],
        );
        if (!ticket || ticket.status !== "granted") {
          throw ApiError.paymentRequired("This room needs a ticket");
        }
      }
      await ctx.pool.query(
        `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2)
         ON CONFLICT (room_id, user_id) DO NOTHING`,
        [id, user.id],
      );
      trackSafe(ctx.pool, { name: "room_joined", userId: user.id, properties: { kind: room.kind, entityType: "room", entityId: id } });
      return { room: await loadRoom(ctx, id, user.id), joined: true };
    });

    // ---- Tickets: a paid live room ----
    //
    // A ticket is a provider checkout plus a ledger journal on the verified
    // webhook, exactly like a paid gift. Nothing is granted here; the grant
    // happens in settleTicketPurchase. Vibe never holds the money as a balance.
    app.post("/v1/activities/rooms/:id/ticket", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const room = await loadRoom(ctx, id, user.id);
      if (!room) throw ApiError.notFound("Room not found");
      if (!room.isTicketed) throw ApiError.badRequest("This room is free to join");
      if (room.host.id === user.id) throw ApiError.badRequest("You host this room");
      const existing = await queryOne<{ status: string }>(
        ctx.pool,
        "SELECT status FROM room_tickets WHERE room_id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (existing?.status === "granted") {
        return { status: "granted", alreadyTickets: true };
      }
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/activities/rooms/:id/ticket", key, requestBody: { roomId: id } },
        async () => {
          const priceMinor = room.ticketPriceMinor;
          const { feeMinor, recipientMinor } = splitGift(priceMinor, TICKET_FEE_BPS);
          const reference = `TKT-${newId()}`;
          const purchaseId = newId();
          await ctx.pool.query(
            `INSERT INTO gift_purchases
               (id, buyer_id, recipient_id, gift_id, quantity, unit_price_minor,
                fee_bps, amount_minor, fee_minor, recipient_minor, currency, reference, provider, room_id)
             VALUES ($1,$2,$3,'live_ticket',1,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              purchaseId, user.id, room.host.id, priceMinor, TICKET_FEE_BPS, priceMinor,
              feeMinor, recipientMinor, "NGN", reference, ctx.provider.name, id,
            ],
          );
          const session = await ctx.provider.createCheckout({
            amount: { amount: priceMinor, currency: "NGN" },
            reference,
            description: `Vibe live ticket: ${room.title}`,
          });
          await ctx.pool.query(
            "UPDATE gift_purchases SET provider_ref = $2, updated_at = now() WHERE id = $1",
            [purchaseId, session.providerRef],
          );
          return {
            statusCode: 202,
            body: {
              purchaseId,
              reference,
              amountMinor: priceMinor,
              feeMinor,
              hostMinor: recipientMinor,
              currency: "NGN",
              // Only the verified webhook grants the ticket.
              status: "pending",
              redirectUrl: session.redirectUrl,
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    app.get("/v1/activities/rooms/:id/ticket", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const ticket = await queryOne(
        ctx.pool,
        `SELECT id, status, price_minor, currency, reference, granted_at
           FROM room_tickets WHERE room_id = $1 AND user_id = $2`,
        [id, user.id],
      );
      return {
        ticket: ticket
          ? {
              id: ticket.id,
              status: ticket.status,
              priceMinor: Number(ticket.price_minor),
              currency: ticket.currency,
              reference: ticket.reference,
              grantedAt: ticket.granted_at,
            }
          : null,
      };
    });

    app.post("/v1/activities/rooms/:id/leave", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await ctx.pool.query(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, [id, user.id]);
      return { left: true };
    });

    // ---- Participate: talk, with spoiler handling and slow mode ----
    app.get("/v1/activities/rooms/:id/posts", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await assertCanSee(ctx, id, user.id);
      const rows = await queryMany<{
        id: string; kind: string; body: string; spoiler: boolean; automated: boolean;
        created_at: Date; author_id: string; handle: string; display_name: string;
        avatar_url: string | null; host_kind: string;
      }>(
        ctx.pool,
        `SELECT p.id, p.kind, p.body, p.spoiler, p.automated, p.created_at,
                p.author_id, u.handle, u.display_name, u.avatar_url, u.host_kind
           FROM room_posts p JOIN users u ON u.id = p.author_id
          WHERE p.room_id = $1 AND p.removed_at IS NULL
          ORDER BY p.created_at ASC LIMIT 200`,
        [id],
      );
      return {
        posts: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          // A spoiler-safe room hides the body until the viewer reveals it.
          body: r.spoiler ? null : r.body,
          hidden: r.spoiler,
          automated: r.automated,
          createdAt: r.created_at,
          author: { id: r.author_id, handle: r.handle, displayName: r.display_name, avatarUrl: r.avatar_url, kind: r.host_kind },
        })),
      };
    });

    app.post("/v1/activities/rooms/:id/posts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const room = await assertCanSee(ctx, id, user.id);
      const input = parse(
        z.object({
          body: z.string().min(1).max(2000),
          kind: z.enum(["message", "nomination"]).default("message"),
          spoiler: z.boolean().default(false),
        }),
        req.body,
      );
      const me = await queryOne<{ muted: boolean }>(
        ctx.pool,
        `SELECT muted FROM room_members WHERE room_id = $1 AND user_id = $2`,
        [id, user.id],
      );
      if (me?.muted) throw ApiError.forbidden("You have muted this room");
      if (room.slow_mode_seconds > 0) {
        const recent = await queryOne<{ created_at: Date }>(
          ctx.pool,
          `SELECT created_at FROM room_posts WHERE room_id = $1 AND author_id = $2
            ORDER BY created_at DESC LIMIT 1`,
          [id, user.id],
        );
        if (recent && Date.now() - new Date(recent.created_at).getTime() < room.slow_mode_seconds * 1000) {
          throw ApiError.tooManyRequests(`Slow mode: wait ${room.slow_mode_seconds}s between posts`);
        }
      }
      const postId = newId();
      // In a spoiler-safe room everything is treated as a spoiler until the
      // viewer chooses to reveal it.
      const spoiler = input.spoiler || room.spoiler_policy === "spoiler_safe";
      await ctx.pool.query(
        `INSERT INTO room_posts (id, room_id, author_id, kind, body, spoiler) VALUES ($1,$2,$3,$4,$5,$6)`,
        [postId, id, user.id, input.kind, input.body, spoiler],
      );
      reply.code(201);
      return { post: { id: postId, kind: input.kind, body: input.body, spoiler, createdAt: new Date() } };
    });

    // ---- Polls: score calls and votes, never wagers ----
    app.post("/v1/activities/rooms/:id/polls", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const room = await assertCanSee(ctx, id, user.id);
      const input = parse(
        z.object({
          question: z.string().min(1).max(200),
          options: z.array(z.string().min(1).max(80)).min(2).max(8),
        }),
        req.body,
      );
      const pollId = newId();
      const options = input.options.map((label, i) => ({ id: `o${i + 1}`, label }));
      await ctx.pool.query(
        `INSERT INTO room_polls (id, room_id, question, options, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [pollId, id, input.question, JSON.stringify(options), user.id],
      );
      reply.code(201);
      return { poll: { id: pollId, question: input.question, options: options.map((o) => ({ ...o, votes: 0 })), kind: room.kind } };
    });

    app.post("/v1/activities/polls/:pollId/votes", async (req) => {
      const user = await requireUser(ctx, req);
      const { pollId } = req.params as { pollId: string };
      const input = parse(z.object({ optionId: z.string().min(1).max(20) }), req.body);
      const poll = await queryOne<{ room_id: string; options: Array<{ id: string }> }>(
        ctx.pool,
        `SELECT room_id, options FROM room_polls WHERE id = $1`,
        [pollId],
      );
      if (!poll) throw ApiError.notFound("Poll not found");
      await assertCanSee(ctx, poll.room_id, user.id);
      if (!poll.options.some((o) => o.id === input.optionId)) throw ApiError.badRequest("Unknown option");
      await ctx.pool.query(
        `INSERT INTO room_poll_votes (poll_id, user_id, option_id) VALUES ($1,$2,$3)
         ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`,
        [pollId, user.id, input.optionId],
      );
      trackSafe(ctx.pool, { name: "vote_submitted", userId: user.id, properties: { entityType: "room", entityId: poll.room_id } });
      return await pollTally(ctx, pollId);
    });

    app.get("/v1/activities/polls/:pollId", async (req) => {
      await requireUser(ctx, req);
      const { pollId } = req.params as { pollId: string };
      return await pollTally(ctx, pollId);
    });

    // ---- Opt-in reminders ----
    app.post("/v1/activities/rooms/:id/reminder", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(z.object({ leadMinutes: z.coerce.number().int().min(0).max(1440).default(15) }), req.body ?? {});
      await ctx.pool.query(
        `INSERT INTO activity_reminders (user_id, room_id, lead_minutes) VALUES ($1,$2,$3)
         ON CONFLICT (user_id, room_id) DO UPDATE SET lead_minutes = EXCLUDED.lead_minutes`,
        [user.id, id, input.leadMinutes],
      );
      return { reminder: { roomId: id, leadMinutes: input.leadMinutes } };
    });

    app.delete("/v1/activities/rooms/:id/reminder", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await ctx.pool.query(`DELETE FROM activity_reminders WHERE user_id = $1 AND room_id = $2`, [user.id, id]);
      return { removed: true };
    });

    // ---- Viral loop: a context-preserving, revocable link ----
    app.post("/v1/activities/rooms/:id/share", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const room = await assertCanSee(ctx, id, user.id);
      const input = parse(z.object({ maxUses: z.coerce.number().int().min(1).max(1000).optional() }), req.body ?? {});
      const token = newToken(12);
      await ctx.pool.query(
        `INSERT INTO activity_links (id, token, room_id, created_by, max_uses) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), token, id, user.id, input.maxUses ?? null],
      );
      trackSafe(ctx.pool, { name: "share_created", userId: user.id, properties: { kind: room.kind, surface: "activity", entityType: "room", entityId: id } });
      reply.code(201);
      return {
        link: {
          token,
          path: `/activity/${token}`,
          url: `${ctx.config.PUBLIC_WEB_URL}/activity/${token}`,
          // A private-room link can be revoked and the host controls who joins.
          revocable: room.visibility === "private",
        },
      };
    });

    // Resolve a link after signup: returns the member to the same room and
    // names one meaningful first action.
    app.post("/v1/activities/links/:token/open", async (req) => {
      const user = await requireUser(ctx, req);
      const { token } = req.params as { token: string };
      const link = await queryOne<{ id: string; room_id: string; revoked_at: Date | null; max_uses: number | null; uses: number }>(
        ctx.pool,
        `SELECT id, room_id, revoked_at, max_uses, uses FROM activity_links WHERE token = $1`,
        [token],
      );
      if (!link || link.revoked_at) throw ApiError.notFound("This link is no longer available");
      if (link.max_uses !== null && link.uses >= link.max_uses) throw ApiError.forbidden("This link has reached its limit");
      await withTransaction(ctx.pool, async (client) => {
        await client.query(`UPDATE activity_links SET uses = uses + 1 WHERE id = $1`, [link.id]);
        await client.query(
          `INSERT INTO room_members (room_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [link.room_id, user.id],
        );
        await client.query(
          `INSERT INTO activity_link_visits (link_id, visitor_id, converted) VALUES ($1,$2,true)`,
          [link.id, user.id],
        );
      });
      trackSafe(ctx.pool, { name: "activity_link_converted", userId: user.id, properties: { surface: "link", entityType: "room", entityId: link.room_id } });
      const room = await loadRoom(ctx, link.room_id, user.id);
      return {
        room,
        // The recipient can take one meaningful action immediately.
        firstAction: room?.state === "live" ? "react_or_vote" : "set_reminder",
      };
    });

    app.post("/v1/activities/links/:token/revoke", async (req) => {
      const user = await requireUser(ctx, req);
      const { token } = req.params as { token: string };
      const link = await queryOne<{ id: string; created_by: string }>(
        ctx.pool,
        `SELECT id, created_by FROM activity_links WHERE token = $1`,
        [token],
      );
      if (!link) throw ApiError.notFound("Link not found");
      if (link.created_by !== user.id) throw ApiError.forbidden("Only the creator can revoke this link");
      await ctx.pool.query(`UPDATE activity_links SET revoked_at = now() WHERE id = $1`, [link.id]);
      return { revoked: true };
    });

    // ---- Host controls (addendum §8) ----
    app.post("/v1/activities/rooms/:id/moderate", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        z.object({
          action: z.enum(["remove_post", "slow_mode", "close_room", "reopen_room"]),
          targetId: z.string().uuid().optional(),
          slowModeSeconds: z.coerce.number().int().min(0).max(600).optional(),
        }),
        req.body,
      );
      await assertHost(ctx, id, user.id);
      if (input.action === "remove_post") {
        if (!input.targetId) throw ApiError.badRequest("targetId is required");
        await ctx.pool.query(
          `UPDATE room_posts SET removed_at = now(), removed_by = $2 WHERE id = $1 AND room_id = $3`,
          [input.targetId, user.id, id],
        );
      } else if (input.action === "slow_mode") {
        await ctx.pool.query(`UPDATE activity_rooms SET slow_mode_seconds = $2 WHERE id = $1`, [id, input.slowModeSeconds ?? 0]);
      } else if (input.action === "close_room") {
        await ctx.pool.query(`UPDATE activity_rooms SET state_override = 'ended' WHERE id = $1`, [id]);
      } else if (input.action === "reopen_room") {
        await ctx.pool.query(`UPDATE activity_rooms SET state_override = NULL WHERE id = $1`, [id]);
      }
      await ctx.pool.query(
        `INSERT INTO room_moderation_actions (id, room_id, actor_id, action, target_id) VALUES ($1,$2,$3,$4,$5)`,
        [newId(), id, user.id, input.action, input.targetId ?? null],
      );
      return { room: await loadRoom(ctx, id, user.id) };
    });

    // ---- Edit / delete (host) ----
    app.patch("/v1/activities/rooms/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await assertHost(ctx, id, user.id);
      const input = parse(
        z.object({
          title: z.string().min(1).max(160).optional(),
          topic: z.string().max(400).nullable().optional(),
          rules: z.string().max(1000).nullable().optional(),
          city: z.string().max(80).nullable().optional(),
          area: z.string().max(80).nullable().optional(),
          bannerUrl: z.string().max(500).nullable().optional(),
          visibility: z.enum(["public", "private"]).optional(),
          ticketPriceMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
          audioTrack: z
            .object({ title: z.string().min(1).max(200), artist: z.string().max(200).optional(), artworkUrl: z.string().max(500).optional() })
            .nullable()
            .optional(),
          startsAt: z.coerce.date().optional(),
          endsAt: z.coerce.date().optional(),
        }),
        req.body,
      );
      const sets: string[] = [];
      const values: unknown[] = [id];
      const put = (col: string, val: unknown) => {
        values.push(val);
        sets.push(`${col} = $${values.length}`);
      };
      if (input.title !== undefined) put("title", input.title);
      if (input.topic !== undefined) put("topic", input.topic);
      if (input.rules !== undefined) put("rules", input.rules);
      if (input.city !== undefined) put("city", input.city);
      if (input.area !== undefined) put("area", input.area);
      if (input.bannerUrl !== undefined) put("banner_url", input.bannerUrl);
      if (input.visibility !== undefined) put("visibility", input.visibility);
      if (input.ticketPriceMinor !== undefined) put("ticket_price_minor", input.ticketPriceMinor);
      if (input.audioTrack !== undefined) put("audio_track", input.audioTrack ? JSON.stringify(input.audioTrack) : null);
      if (input.startsAt !== undefined) put("starts_at", input.startsAt);
      if (input.endsAt !== undefined) put("ends_at", input.endsAt);
      if (sets.length === 0) throw ApiError.badRequest("Nothing to update");
      await ctx.pool.query(`UPDATE activity_rooms SET ${sets.join(", ")}, edited_at = now() WHERE id = $1`, values);
      const room = await loadRoom(ctx, id, user.id);
      ctx.hub.publishToRoom(id, { type: "room.updated", entityId: id, payload: { room } });
      return { room };
    });

    app.delete("/v1/activities/rooms/:id", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await assertHost(ctx, id, user.id);
      // A room with a paid ticket history is ended rather than deleted, so the
      // money trail stays intact; a free room is removed outright.
      const paid = await queryOne<{ n: string }>(
        ctx.pool,
        `SELECT count(*)::int AS n FROM room_tickets WHERE room_id = $1`,
        [id],
      );
      if (Number(paid?.n ?? 0) > 0) {
        await ctx.pool.query(`UPDATE activity_rooms SET state_override = 'ended', edited_at = now() WHERE id = $1`, [id]);
        ctx.hub.publishToRoom(id, { type: "room.ended", entityId: id, payload: {} });
        return { id, deleted: false, ended: true };
      }
      await ctx.pool.query(`DELETE FROM activity_rooms WHERE id = $1`, [id]);
      ctx.hub.publishToRoom(id, { type: "room.deleted", entityId: id, payload: {} });
      reply.code(200);
      return { id, deleted: true, ended: false };
    });

    // ---- Stage & audience (voice/listen rooms) ----
    app.get("/v1/activities/rooms/:id/members", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await assertCanSee(ctx, id, user.id);
      const rows = await queryMany<{
        user_id: string; role: string; hand_raised: boolean; muted: boolean; muted_by_host: boolean;
        handle: string; display_name: string; avatar_url: string | null; host_kind: string;
      }>(
        ctx.pool,
        `SELECT m.user_id, m.role, m.hand_raised, m.muted, m.muted_by_host,
                u.handle, u.display_name, u.avatar_url, u.host_kind
           FROM room_members m JOIN users u ON u.id = m.user_id
          WHERE m.room_id = $1
          ORDER BY (m.role = 'host') DESC, (m.role = 'speaker') DESC, m.joined_at ASC
          LIMIT 200`,
        [id],
      );
      const stage = rows.filter((r) => r.role === "host" || r.role === "speaker" || r.role === "moderator");
      const audience = rows.filter((r) => !(r.role === "host" || r.role === "speaker" || r.role === "moderator"));
      const view = (r: typeof rows[number]) => ({
        id: r.user_id,
        handle: r.handle,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        role: r.role,
        hostKind: r.host_kind,
        handRaised: r.hand_raised,
        muted: r.muted || r.muted_by_host,
        mutedByHost: r.muted_by_host,
      });
      return {
        stage: stage.map(view),
        audience: audience.map(view),
        stageCount: stage.length,
        audienceCount: audience.length,
      };
    });

    // Raise or lower a hand: the listener asks to be brought up.
    app.post("/v1/activities/rooms/:id/hand", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(z.object({ raised: z.boolean() }), req.body);
      await ctx.pool.query(
        `INSERT INTO room_members (room_id, user_id, hand_raised) VALUES ($1,$2,$3)
         ON CONFLICT (room_id, user_id) DO UPDATE SET hand_raised = EXCLUDED.hand_raised`,
        [id, user.id, input.raised],
      );
      ctx.hub.publishToRoom(id, {
        type: "room.hand",
        entityId: id,
        payload: { userId: user.id, handle: user.handle, raised: input.raised },
      });
      return { raised: input.raised };
    });

    // Bring a listener up to the stage, or send a speaker back to the audience.
    app.post("/v1/activities/rooms/:id/stage", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        z.object({
          userId: z.string().uuid(),
          action: z.enum(["promote", "demote", "mute", "unmute"]),
        }),
        req.body,
      );
      await assertHost(ctx, id, user.id);
      const room = await queryOne<{ kind: string }>(ctx.pool, `SELECT kind FROM activity_rooms WHERE id = $1`, [id]);
      if (room && !["voice", "listen", "other"].includes(room.kind)) {
        throw ApiError.badRequest("This room kind does not have a stage");
      }
      if (input.action === "promote") {
        await ctx.pool.query(
          `INSERT INTO room_members (room_id, user_id, role, hand_raised) VALUES ($1,$2,'speaker',false)
           ON CONFLICT (room_id, user_id) DO UPDATE SET role = 'speaker', hand_raised = false`,
          [id, input.userId],
        );
      } else if (input.action === "demote") {
        await ctx.pool.query(
          `UPDATE room_members SET role = 'member', muted_by_host = false WHERE room_id = $1 AND user_id = $2`,
          [id, input.userId],
        );
      } else if (input.action === "mute") {
        await ctx.pool.query(
          `UPDATE room_members SET muted_by_host = true WHERE room_id = $1 AND user_id = $2`,
          [id, input.userId],
        );
      } else {
        await ctx.pool.query(
          `UPDATE room_members SET muted_by_host = false WHERE room_id = $1 AND user_id = $2`,
          [id, input.userId],
        );
      }
      ctx.hub.publishToRoom(id, {
        type: "room.stage",
        entityId: id,
        payload: { userId: input.userId, action: input.action, by: user.id },
      });
      return { ok: true };
    });

    // ---- Free gifts in a room (energy) ----
    app.post("/v1/activities/rooms/:id/gifts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        z.object({ kind: z.enum(["sparkle", "high_five", "cheer", "hug", "fire"]), recipientId: z.string().uuid().optional() }),
        req.body,
      );
      const room = await queryOne<{ host_id: string }>(ctx.pool, `SELECT host_id FROM activity_rooms WHERE id = $1`, [id]);
      if (!room) throw ApiError.notFound("Room not found");
      const recipientId = input.recipientId ?? room.host_id;
      if (recipientId === user.id) throw ApiError.badRequest("You cannot gift yourself");
      const inserted = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO room_gifts (room_id, sender_id, recipient_id, kind) VALUES ($1,$2,$3,$4) RETURNING id`,
        [id, user.id, recipientId, input.kind],
      );
      ctx.hub.publishToRoom(id, {
        type: "room.gift",
        entityId: id,
        payload: { kind: input.kind, from: user.handle, fromName: user.displayName, to: recipientId, giftId: inserted!.id },
      });
      reply.code(201);
      return { ok: true };
    });

    // ---- Reactions (the energy burst) ----
    app.post("/v1/activities/rooms/:id/reactions", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(z.object({ emoji: z.string().min(1).max(8) }), req.body);
      await ctx.pool.query(
        `INSERT INTO room_reactions (room_id, user_id, emoji) VALUES ($1,$2,$3)`,
        [id, user.id, input.emoji],
      );
      ctx.hub.publishToRoom(id, {
        type: "room.reaction",
        entityId: id,
        payload: { emoji: input.emoji, from: user.handle },
      });
      reply.code(201);
      return { ok: true };
    });

    // ---- Room energy ----
    app.get("/v1/activities/rooms/:id/hype", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      await assertCanSee(ctx, id, user.id);
      return { hype: await computeHype(ctx, id) };
    });
  };
}

/**
 * Energy for a room, recomputed from the last hour of activity rather than
 * stored as a running total. Reactions and gifts raise it; it naturally decays
 * as the window slides. The result is cached on the room for cheap listing.
 */
export async function computeHype(ctx: AppContext, roomId: string): Promise<number> {
  const row = await queryOne<{ reactions: string; gifts: string; paid: string; members: string; messages: string }>(
    ctx.pool,
    `SELECT
       (SELECT count(*) FROM room_reactions WHERE room_id = $1 AND created_at > now() - interval '1 hour') AS reactions,
       (SELECT count(*) FROM room_gifts     WHERE room_id = $1 AND created_at > now() - interval '1 hour') AS gifts,
       (SELECT count(*) FROM paid_gifts     WHERE room_id = $1 AND created_at > now() - interval '1 hour') AS paid,
       (SELECT count(*) FROM room_members   WHERE room_id = $1) AS members,
       (SELECT count(*) FROM room_posts     WHERE room_id = $1 AND created_at > now() - interval '1 hour' AND removed_at IS NULL) AS messages`,
    [roomId],
  );
  const hype = Math.round(
    Number(row?.reactions ?? 0) * 1 +
    Number(row?.gifts ?? 0) * 3 +
    Number(row?.paid ?? 0) * 20 +
    Number(row?.members ?? 0) * 2 +
    Number(row?.messages ?? 0) * 1,
  );
  await ctx.pool.query(`UPDATE activity_rooms SET hype = $2 WHERE id = $1`, [roomId, hype]);
  return hype;
}

const ROOM_SELECT = `
  SELECT r.*, u.handle AS host_handle, u.display_name AS host_name,
         u.host_kind, u.host_disclosure,
         (SELECT count(*)::int FROM room_members m WHERE m.room_id = r.id) AS member_count
    FROM activity_rooms r JOIN users u ON u.id = r.host_id`;

async function loadRoom(ctx: AppContext, id: string, viewerId: string | null) {
  const room = await queryOne<RoomRow>(ctx.pool, `${ROOM_SELECT} WHERE r.id = $1`, [id]);
  if (!room) return null;
  if (room.visibility === "private" && viewerId) {
    const member = await queryOne(
      ctx.pool,
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [id, viewerId],
    );
    if (!member && room.host_id !== viewerId) return null;
  }
  return serializeRoom(room);
}

async function assertCanSee(ctx: AppContext, id: string, viewerId: string): Promise<RoomRow> {
  const room = await queryOne<RoomRow>(ctx.pool, `${ROOM_SELECT} WHERE r.id = $1`, [id]);
  if (!room) throw ApiError.notFound("Room not found");
  if (room.visibility === "private") {
    const member = await queryOne(
      ctx.pool,
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [id, viewerId],
    );
    if (!member && room.host_id !== viewerId) throw ApiError.forbidden("This is a private room");
  }
  return room;
}

async function assertHost(ctx: AppContext, id: string, userId: string): Promise<void> {
  const room = await queryOne<{ host_id: string }>(ctx.pool, `SELECT host_id FROM activity_rooms WHERE id = $1`, [id]);
  if (!room) throw ApiError.notFound("Room not found");
  if (room.host_id === userId) return;
  const mod = await queryOne(
    ctx.pool,
    `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND role IN ('host','moderator')`,
    [id, userId],
  );
  if (!mod) throw ApiError.forbidden("Only the host can do that");
}

async function pollTally(ctx: AppContext, pollId: string) {
  const poll = await queryOne<{ id: string; room_id: string; question: string; options: Array<{ id: string; label: string }> }>(
    ctx.pool,
    `SELECT id, room_id, question, options FROM room_polls WHERE id = $1`,
    [pollId],
  );
  if (!poll) throw ApiError.notFound("Poll not found");
  const counts = await queryMany<{ option_id: string; count: number }>(
    ctx.pool,
    `SELECT option_id, count(*)::int AS count FROM room_poll_votes WHERE poll_id = $1 GROUP BY option_id`,
    [pollId],
  );
  const byId = new Map(counts.map((c) => [c.option_id, c.count]));
  return {
    poll: {
      id: poll.id,
      roomId: poll.room_id,
      question: poll.question,
      options: poll.options.map((o) => ({ ...o, votes: byId.get(o.id) ?? 0 })),
      totalVotes: counts.reduce((n, c) => n + c.count, 0),
    },
  };
}
