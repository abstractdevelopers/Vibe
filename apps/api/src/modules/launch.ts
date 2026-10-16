import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId, newToken } from "../ids.js";
import { parse, requireAdmin, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Launch seeding (addendum §7) — the honest version.
 *
 * The addendum asks for two different things and only one of them is buildable:
 *
 *   a) Official Vibe-hosted programming with clearly identified automated
 *      hosts, a published schedule, real founding members and starter prompts.
 *      -> built here.
 *   b) An algorithm that populates the platform as fake humans, invisible even
 *      to someone inspecting it, until 1000 real users exist.
 *      -> NOT built, by design. That is covert astroturfing: fabricated
 *         histories, manufactured social proof and deliberate evasion of
 *         inspection. It is the same technique used by disinformation
 *         operations, and it is exactly what the addendum's own §7 trust
 *         guardrails forbid ("do not build bots that secretly pose as
 *         independent real people ... or deliberately evade inspection").
 *
 * What replaces (b): official hosts that are labelled as official on every
 * surface, and a staging-only synthetic-traffic harness (see
 * scripts/synthetic-traffic.mjs) that is refused in production and writes
 * nothing into production analytics or public feeds.
 */

const OFFICIAL_SEEDS = [
  { handle: "vibe.matchday", name: "Vibe Matchday", kind: "sports" as const, topic: "Live match rooms, fan polls and post-match reactions." },
  { handle: "vibe.filmclub", name: "Vibe Film Club", kind: "movie" as const, topic: "Group picks, spoiler-safe discussion and watch parties." },
  { handle: "vibe.listeningroom", name: "Vibe Listening Room", kind: "music" as const, topic: "Shared listening, track reactions and genre nights." },
];

export function launchRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // A published schedule any visitor can read before there is a friend graph.
    app.get("/v1/launch/schedule", async (req) => {
      await requireUser(ctx, req);
      const rows = await queryMany<{
        id: string; kind: string; title: string; starts_at: Date; ends_at: Date;
        city: string | null; state_override: string | null; recurrence: string | null;
        host_kind: string; host_disclosure: string | null; handle: string; display_name: string;
      }>(
        ctx.pool,
        `SELECT r.id, r.kind, r.title, r.starts_at, r.ends_at, r.city, r.state_override,
                r.recurrence, u.host_kind, u.host_disclosure, u.handle, u.display_name
           FROM activity_rooms r JOIN users u ON u.id = r.host_id
          WHERE u.host_kind IN ('official', 'automated')
            AND r.visibility = 'public'
            AND r.ends_at > now()
          ORDER BY r.starts_at ASC LIMIT 50`,
      );
      return {
        schedule: rows.map((r) => ({
          id: r.id, kind: r.kind, title: r.title, startsAt: r.starts_at, endsAt: r.ends_at,
          city: r.city, recurrence: r.recurrence,
          host: { handle: r.handle, displayName: r.display_name, kind: r.host_kind, disclosure: r.host_disclosure },
        })),
      };
    });

    // The official roster, so the labels are inspectable by anyone.
    app.get("/v1/launch/official-hosts", async (req) => {
      await requireUser(ctx, req);
      const rows = await queryMany<{ id: string; handle: string; display_name: string; host_kind: string; host_disclosure: string | null }>(
        ctx.pool,
        `SELECT id, handle, display_name, host_kind, host_disclosure FROM users
          WHERE host_kind IN ('official', 'automated') ORDER BY handle`,
      );
      return { hosts: rows };
    });

    // Operator: create the official Vibe-hosted rooms for launch. Idempotent —
    // running it twice does not duplicate the roster.
    app.post("/v1/launch/seed-official", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const input = parse(
        z.object({
          schedule: z
            .array(
              z.object({
                kind: z.enum(["sports", "movie", "music"]),
                title: z.string().min(1).max(160),
                topic: z.string().max(400).optional(),
                startsAt: z.coerce.date(),
                durationMinutes: z.coerce.number().int().min(5).max(1440).default(120),
                recurrence: z.enum(["weekly", "fortnightly", "monthly"]).optional(),
                externalUrl: z.string().url().max(500).optional(),
              }),
            )
            .max(30),
        }),
        req.body ?? {},
      );

      const created: string[] = [];
      await withTransaction(ctx.pool, async (client) => {
        const hostIds = new Map<string, string>();
        for (const seed of OFFICIAL_SEEDS) {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM users WHERE handle = $1`,
            [seed.handle],
          );
          if (existing.rows[0]) {
            hostIds.set(seed.handle, existing.rows[0].id);
            continue;
          }
          // An official host is a real account with host_kind='official' and a
          // plain-language disclosure. It is not pretending to be a person.
          const id = newId();
          await client.query(
            `INSERT INTO users (id, email, handle, display_name, password_hash, host_kind, host_disclosure, bio, interests)
             VALUES ($1,$2,$3,$4,$5,'official',$6,$7,$8)`,
            [
              id,
              `${seed.handle}@hosts.vibe.internal`,
              seed.handle,
              seed.name,
              // No usable password: this account is not signed into by a human
              // and cannot be authenticated as one.
              "!disabled",
              `${seed.name} is an official, automated host run by Vibe. ${seed.topic}`,
              seed.topic,
              [seed.kind],
            ],
          );
          hostIds.set(seed.handle, id);
        }
        for (const item of input.schedule) {
          const handle = item.kind === "sports" ? "vibe.matchday" : item.kind === "movie" ? "vibe.filmclub" : "vibe.listeningroom";
          const hostId = hostIds.get(handle);
          if (!hostId) continue;
          const endsAt = new Date(item.startsAt.getTime() + item.durationMinutes * 60_000);
          const id = newId();
          await client.query(
            `INSERT INTO activity_rooms
               (id, kind, title, topic, starts_at, ends_at, visibility, host_id,
                external_url, playback_mode, spoiler_policy, recurrence, data_source)
             VALUES ($1,$2,$3,$4,$5,$6,'public',$7,$8,'coordinated',$9,$10,$11)`,
            [
              id, item.kind, item.title, item.topic ?? null, item.startsAt, endsAt, hostId,
              item.externalUrl ?? null,
              item.kind === "movie" ? "spoiler_safe" : "open",
              item.recurrence ?? null,
              item.kind === "sports" ? "official fixtures feed (authorized source required)" : null,
            ],
          );
          await client.query(`INSERT INTO room_members (room_id, user_id, role) VALUES ($1,$2,'host')`, [id, hostId]);
          created.push(id);
        }
      });
      return { created, hosts: [...OFFICIAL_SEEDS.map((s) => s.handle)] };
    });

    // ---- AI host capabilities (§7), each one inside its permitted lane ----
    app.post("/v1/launch/rooms/:id/host-post", async (req, reply) => {
      const actor = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        z.object({
          kind: z.enum(["prompt", "recap", "nomination", "system"]),
          body: z.string().min(1).max(2000),
        }),
        req.body,
      );
      const room = await queryOne<{ host_id: string; host_kind: string }>(
        ctx.pool,
        `SELECT r.host_id, u.host_kind FROM activity_rooms r JOIN users u ON u.id = r.host_id WHERE r.id = $1`,
        [id],
      );
      if (!room) throw ApiError.notFound("Room not found");
      // Only an official/automated host account, or an operator, may post as
      // the host. A person cannot post under a host label.
      if (room.host_id !== actor.id && !actor.isAdmin) {
        throw ApiError.forbidden("Only the host account can post as the host");
      }
      if (room.host_kind === "person" && !actor.isAdmin) {
        throw ApiError.forbidden("This room has a human host; use a normal post");
      }
      const postId = newId();
      await ctx.pool.query(
        `INSERT INTO room_posts (id, room_id, author_id, kind, body, automated) VALUES ($1,$2,$3,$4,$5,true)`,
        [postId, id, room.host_id, input.kind, input.body],
      );
      reply.code(201);
      return { post: { id: postId, kind: input.kind, body: input.body, automated: true } };
    });

    // Escalation: an official host hands a sensitive case to a human moderator.
    app.post("/v1/launch/rooms/:id/escalate", async (req, reply) => {
      const actor = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        z.object({ reason: z.string().min(1).max(1000), targetType: z.string().max(40).optional(), targetId: z.string().uuid().optional() }),
        req.body,
      );
      const room = await queryOne<{ host_id: string }>(ctx.pool, `SELECT host_id FROM activity_rooms WHERE id = $1`, [id]);
      if (!room) throw ApiError.notFound("Room not found");
      if (room.host_id !== actor.id && !actor.isAdmin) throw ApiError.forbidden("Only the host can escalate");
      // Goes into the ordinary moderation queue, so a person always reviews it.
      const reportId = newId();
      await ctx.pool.query(
        `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status)
         VALUES ($1,$2,$3,$4,$5,'open')`,
        [reportId, actor.id, input.targetType ?? "activity", input.targetId ?? id, `Host escalation: ${input.reason}`],
      );
      trackSafe(ctx.pool, { name: "report_submitted", userId: actor.id, properties: { surface: "host_escalation", entityType: "room", entityId: id } });
      reply.code(201);
      return { escalated: true, reportId };
    });
  };
}
