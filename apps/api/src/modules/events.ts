import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId, newToken, sha256Hex } from "../ids.js";
import { authenticate, parse, publicUser, requireUser, type AppContext } from "../http.js";
import { requireCircleMember, requireCircleRole } from "./access.js";
import { trackSafe } from "./analytics.js";
import { notifyUsers } from "./notifications.js";

/**
 * Events and IRL check-in (§4.5, Phase 4).
 *
 * Two boundaries the spec draws are held here:
 *
 *   - A Vibe event is not a reservation or a ticket. Ticketing is a
 *     provider/merchant concern; an event only records a *verified* booking
 *     reference if one exists, and never claims one otherwise.
 *   - A check-in code is a random, revocable, expiring, single-use (by default)
 *     token, validated server-side. Nothing sensitive is encoded in the QR; the
 *     QR only carries the code, which the server looks up by hash.
 */

const createEventSchema = z.object({
  title: z.string().min(1).max(160),
  description: z.string().max(4000).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
  timezone: z.string().min(1).max(64).default("UTC"),
  place: z.string().max(300).optional(),
  city: z.string().max(80).optional(),
  area: z.string().max(80).optional(),
  // Banner artwork. Same contract as a campaign creative and an avatar: an
  // absolute http(s) URL or an uploaded media path.
  imageUrl: z
    .string()
    .max(500)
    .regex(/^(https?:\/\/|\/v1\/media\/[A-Za-z0-9._-]+$)/, "imageUrl must be an http(s) URL or a media path")
    .optional(),
  priceMinor: z.number().int().nonnegative().default(0),
  currency: z.string().length(3).default("NGN"),
  circleId: z.string().uuid().optional(),
  merchantId: z.string().uuid().optional(),
  // Ticketing boundary: only set when a provider has actually confirmed it.
  bookingProvider: z.string().max(40).optional(),
  bookingRef: z.string().max(120).optional(),
});

const checkinCodeSchema = z.object({
  // A short window by default; the organizer can extend it explicitly.
  ttlMinutes: z.number().int().positive().max(60 * 24 * 30).default(180),
  maxUses: z.number().int().positive().max(10000).default(1),
});

const checkinSchema = z.object({
  code: z.string().min(4).max(200),
});

function eventView(e: {
  id: string; title: string; description: string | null; starts_at: Date; ends_at: Date | null;
  timezone: string; place: string | null; city: string | null; area: string | null;
  price_minor: number; currency: string; state: string; circle_id: string | null;
  image_url: string | null;
  organizer_id: string; handle: string; display_name: string; avatar_url: string | null;
  booking_verified: boolean; booking_provider: string | null; booking_ref: string | null;
}) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    timezone: e.timezone,
    place: e.place,
    city: e.city,
    area: e.area,
    imageUrl: e.image_url,
    priceMinor: e.price_minor,
    currency: e.currency,
    state: e.state,
    circleId: e.circle_id,
    organizer: publicUser({ id: e.organizer_id, handle: e.handle, display_name: e.display_name, avatar_url: e.avatar_url }),
    // A booking is only shown as confirmed when a provider reference backs it.
    booking: e.booking_verified
      ? { verified: true, provider: e.booking_provider, reference: e.booking_ref }
      : { verified: false, provider: null, reference: null },
  };
}

export function eventsRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/events", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createEventSchema, req.body);
      if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
        throw ApiError.badRequest("endsAt must be after startsAt");
      }
      if (input.circleId) await requireCircleMember(ctx.pool, input.circleId, user.id);
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO events (id, organizer_id, circle_id, merchant_id, title, description, starts_at, ends_at,
                             timezone, place, city, area, image_url, price_minor, currency, booking_provider, booking_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          newId(), user.id, input.circleId ?? null, input.merchantId ?? null, input.title,
          input.description ?? null, input.startsAt, input.endsAt ?? null, input.timezone,
          input.place ?? null, input.city ?? null, input.area ?? null, input.imageUrl ?? null,
          input.priceMinor,
          input.currency.toUpperCase(), input.bookingProvider ?? null, input.bookingRef ?? null,
        ],
      );
      reply.code(201);
      return { id: created!.id, state: "draft" };
    });

    app.post("/v1/events/:id/publish", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const e = await queryOne<{ organizer_id: string; circle_id: string | null; state: string }>(
        ctx.pool,
        "SELECT organizer_id, circle_id, state FROM events WHERE id = $1",
        [id],
      );
      if (!e) throw ApiError.notFound("Event not found");
      if (e.organizer_id !== user.id && !user.isAdmin) throw ApiError.forbidden("Only the organizer can publish");
      if (e.state !== "draft") throw ApiError.badRequest(`An event in "${e.state}" cannot be published`);
      await ctx.pool.query("UPDATE events SET state = 'published', updated_at = now() WHERE id = $1", [id]);
      if (e.circle_id) {
        const members = await queryMany<{ user_id: string }>(
          ctx.pool,
          "SELECT user_id FROM circle_members WHERE circle_id = $1 AND user_id <> $2",
          [e.circle_id, user.id],
        );
        await notifyUsers(ctx.pool, members.map((m) => m.user_id), "event.published", "event", id, {});
      }
      return { id, state: "published" };
    });

    app.get("/v1/events", async (req) => {
      // Published events are public: anyone, signed in or not, can see what is
      // on. Drafts and cancelled events stay private to their organizer.
      await authenticate(ctx, req);
      const q = req.query as { city?: string; circleId?: string; limit?: string };
      const limit = Math.min(Number(q.limit ?? 20) || 20, 50);
      const rows = await queryMany<Parameters<typeof eventView>[0]>(
        ctx.pool,
        `SELECT e.*, u.handle, u.display_name, u.avatar_url
           FROM events e JOIN users u ON u.id = e.organizer_id
          WHERE e.state = 'published'
            AND ($1::text IS NULL OR e.city = $1)
            AND ($2::uuid IS NULL OR e.circle_id = $2::uuid)
          ORDER BY e.starts_at ASC
          LIMIT $3`,
        [q.city ?? null, q.circleId ?? null, limit],
      );
      return { events: rows.map(eventView) };
    });

    app.get("/v1/events/:id", async (req) => {
      const viewer = await authenticate(ctx, req);
      const { id } = req.params as { id: string };
      const e = await queryOne<Parameters<typeof eventView>[0] & { organizer_id: string; state: string }>(
        ctx.pool,
        `SELECT e.*, u.handle, u.display_name, u.avatar_url
           FROM events e JOIN users u ON u.id = e.organizer_id
          WHERE e.id = $1`,
        [id],
      );
      if (!e) throw ApiError.notFound("Event not found");
      // A published event is public; anything else is only for its organizer.
      if (e.state !== "published" && e.organizer_id !== viewer?.id && !viewer?.isAdmin) {
        throw ApiError.notFound("Event not found");
      }
      const checkins = await queryMany<{ user_id: string }>(
        ctx.pool,
        "SELECT user_id FROM checkins WHERE event_id = $1",
        [id],
      );
      return { ...eventView(e as never), checkinCount: checkins.length };
    });

    /**
     * Issue a check-in code. The raw code is returned exactly once; only its
     * hash is stored, so a database leak cannot be used to check anyone in.
     */
    app.post("/v1/events/:id/checkin-codes", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(checkinCodeSchema, req.body ?? {});
      const e = await queryOne<{ organizer_id: string; circle_id: string | null }>(
        ctx.pool,
        "SELECT organizer_id, circle_id FROM events WHERE id = $1",
        [id],
      );
      if (!e) throw ApiError.notFound("Event not found");
      // Only the organizer (or a Circle admin for a Circle event) may mint codes.
      if (e.organizer_id !== user.id) {
        if (!user.isAdmin && e.circle_id) {
          await requireCircleRole(ctx.pool, e.circle_id, user.id, "admin");
        } else if (!user.isAdmin) {
          throw ApiError.forbidden("Only the organizer can issue check-in codes");
        }
      }
      const code = newToken(18);
      const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
      await ctx.pool.query(
        `INSERT INTO checkin_codes (id, event_id, code_hash, expires_at, max_uses)
         VALUES ($1, $2, $3, $4, $5)`,
        [newId(), id, sha256Hex(code), expiresAt, input.maxUses],
      );
      reply.code(201);
      return { code, expiresAt, maxUses: input.maxUses };
    });

    /** Revoke a code so it can no longer check anyone in. */
    app.post("/v1/events/:id/checkin-codes/:codeId/revoke", async (req) => {
      const user = await requireUser(ctx, req);
      const { id, codeId } = req.params as { id: string; codeId: string };
      const e = await queryOne<{ organizer_id: string }>(ctx.pool, "SELECT organizer_id FROM events WHERE id = $1", [id]);
      if (!e) throw ApiError.notFound("Event not found");
      if (e.organizer_id !== user.id && !user.isAdmin) throw ApiError.forbidden("Only the organizer can revoke codes");
      const res = await ctx.pool.query(
        "UPDATE checkin_codes SET revoked_at = now() WHERE id = $1 AND event_id = $2 AND revoked_at IS NULL",
        [codeId, id],
      );
      if ((res.rowCount ?? 0) === 0) throw ApiError.notFound("No active code with that id");
      return { revoked: true };
    });

    /**
     * Check in with a code. Validated server-side: the code must exist, not be
     * revoked or expired, and be under its use limit. A person checks in once.
     */
    app.post("/v1/events/:id/checkin", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(checkinSchema, req.body);
      const codeHash = sha256Hex(input.code);
      const code = await queryOne<{
        id: string; expires_at: Date; revoked_at: Date | null; max_uses: number; uses: number;
      }>(
        ctx.pool,
        `SELECT id, expires_at, revoked_at, max_uses, uses FROM checkin_codes
          WHERE event_id = $1 AND code_hash = $2`,
        [id, codeHash],
      );
      if (!code) throw ApiError.badRequest("That check-in code is not valid");
      if (code.revoked_at) throw ApiError.badRequest("That check-in code has been revoked");
      if (code.expires_at.getTime() <= Date.now()) throw ApiError.badRequest("That check-in code has expired");
      if (code.uses >= code.max_uses) throw ApiError.badRequest("That check-in code has been used up");

      const already = await queryOne<{ id: string }>(
        ctx.pool,
        "SELECT id FROM checkins WHERE event_id = $1 AND user_id = $2",
        [id, user.id],
      );
      if (already) return { checkedIn: true, alreadyCheckedIn: true };

      await withTransaction(ctx.pool, async (tx) => {
        await tx.query("INSERT INTO checkins (id, event_id, user_id, code_id) VALUES ($1, $2, $3, $4)", [
          newId(), id, user.id, code.id,
        ]);
        await tx.query("UPDATE checkin_codes SET uses = uses + 1 WHERE id = $1", [code.id]);
      });
      trackSafe(ctx.pool, { name: "checkin_completed", userId: user.id, properties: { entityType: "event", entityId: id } });
      reply.code(201);
      return { checkedIn: true, alreadyCheckedIn: false };
    });

    /** The organizer's attendance list. */
    app.get("/v1/events/:id/checkins", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const e = await queryOne<{ organizer_id: string; circle_id: string | null }>(
        ctx.pool,
        "SELECT organizer_id, circle_id FROM events WHERE id = $1",
        [id],
      );
      if (!e) throw ApiError.notFound("Event not found");
      if (e.organizer_id !== user.id && !user.isAdmin) {
        if (!e.circle_id) throw ApiError.forbidden("Only the organizer can view attendance");
        await requireCircleMember(ctx.pool, e.circle_id, user.id);
      }
      const rows = await queryMany(
        ctx.pool,
        `SELECT c.created_at AS checked_in_at, u.id, u.handle, u.display_name, u.avatar_url
           FROM checkins c JOIN users u ON u.id = c.user_id
          WHERE c.event_id = $1 ORDER BY c.created_at ASC`,
        [id],
      );
      return {
        checkins: rows.map((r) => ({
          checkedInAt: r.checked_in_at,
          user: publicUser(r as never),
        })),
      };
    });
  };
}

