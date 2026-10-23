import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireCircleMember } from "./access.js";
import { trackSafe } from "./analytics.js";
import { notifyUsers } from "./notifications.js";

const createPlanSchema = z.object({
  circleId: z.string().uuid(),
  title: z.string().min(1).max(140),
  description: z.string().max(2000).optional(),
  startsAt: z.string().datetime(),
  timezone: z.string().min(1).max(64).default("UTC"),
  place: z.string().max(300).optional(),
  onlineUrl: z.string().url().max(500).optional(),
  budgetAmount: z.number().int().nonnegative().optional(),
  budgetCurrency: z.string().length(3).optional(),
  participantLimit: z.number().int().positive().optional(),
  cancellationPolicy: z.string().max(1000).optional(),
  city: z.string().max(80).optional(),
  area: z.string().max(80).optional(),
  discoverable: z.boolean().default(false),
});

const rsvpSchema = z.object({
  state: z.enum(["interested", "going", "waitlisted", "declined", "checked_in"]),
});

async function notifyCircle(
  ctx: AppContext,
  circleId: string,
  exceptUserId: string,
  type: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const members = await queryMany<{ user_id: string }>(
    ctx.pool,
    "SELECT user_id FROM circle_members WHERE circle_id = $1 AND user_id <> $2",
    [circleId, exceptUserId],
  );
  await notifyUsers(ctx, members.map((m) => m.user_id), type, "plan", entityId, payload);
  ctx.hub.publishToUsers(
    members.map((m) => m.user_id),
    { type: "plan.updated", entityId, payload },
  );
}

export function plansRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/plans", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createPlanSchema, req.body);
      await requireCircleMember(ctx.pool, input.circleId, user.id);
      if (input.budgetAmount !== undefined && !input.budgetCurrency) {
        throw ApiError.badRequest("budgetCurrency is required when budgetAmount is set");
      }
      const plan = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO plans (id, circle_id, organizer_id, title, description, state, starts_at, timezone,
                            place, online_url, budget_amount, budget_currency, participant_limit, cancellation_policy,
                            city, area, discoverable)
         VALUES ($1, $2, $3, $4, $5, 'proposed', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
        [
          newId(),
          input.circleId,
          user.id,
          input.title,
          input.description ?? null,
          new Date(input.startsAt),
          input.timezone,
          input.place ?? null,
          input.onlineUrl ?? null,
          input.budgetAmount ?? null,
          input.budgetCurrency ?? null,
          input.participantLimit ?? null,
          input.cancellationPolicy ?? null,
          input.city ?? null,
          input.area ?? null,
          input.discoverable,
        ],
      );
      await notifyCircle(ctx, input.circleId, user.id, "plan.created", plan!.id, {
        title: input.title,
        startsAt: input.startsAt,
      });
      trackSafe(ctx.pool, { name: "plan_created", userId: user.id, properties: { entityType: "plan", entityId: plan!.id } });
      reply.code(201);
      return { id: plan!.id };
    });

    app.get("/v1/plans/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const plan = await queryOne<Record<string, unknown> & { circle_id: string }>(
        ctx.pool,
        `SELECT id, circle_id, organizer_id, title, description, state, starts_at, timezone, place,
                online_url, budget_amount, budget_currency, participant_limit, cancellation_policy
           FROM plans WHERE id = $1`,
        [id],
      );
      if (!plan) throw ApiError.notFound("Plan not found");
      await requireCircleMember(ctx.pool, plan.circle_id, user.id);
      const rsvps = await queryMany<{ user_id: string; state: string }>(
        ctx.pool,
        "SELECT user_id, state FROM rsvps WHERE plan_id = $1",
        [id],
      );
      const going = rsvps.filter((r) => r.state === "going" || r.state === "checked_in").length;
      return {
        plan: {
          id: plan.id,
          circleId: plan.circle_id,
          organizerId: plan.organizer_id,
          title: plan.title,
          description: plan.description,
          state: plan.state,
          startsAt: plan.starts_at,
          timezone: plan.timezone,
          place: plan.place,
          onlineUrl: plan.online_url,
          budgetAmount: plan.budget_amount,
          budgetCurrency: plan.budget_currency,
          participantLimit: plan.participant_limit,
          cancellationPolicy: plan.cancellation_policy,
        },
        goingCount: going,
        rsvps: rsvps.map((r) => ({ userId: r.user_id, state: r.state })),
      };
    });

    app.post("/v1/plans/:id/rsvps", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(rsvpSchema, req.body);
      // Count and write under one lock. Two people RSVPing to the last place
      // simultaneously used to both see a free slot and both go.
      const { state, circleId } = await withTransaction(ctx.pool, async (tx) => {
        const plan = await queryOne<{
          circle_id: string;
          participant_limit: number | null;
          organizer_id: string;
        }>(
          tx,
          "SELECT circle_id, participant_limit, organizer_id FROM plans WHERE id = $1 FOR UPDATE",
          [id],
        );
        if (!plan) throw ApiError.notFound("Plan not found");
        await requireCircleMember(tx as unknown as typeof ctx.pool, plan.circle_id, user.id);

        let next = input.state;
        if (input.state === "going" && plan.participant_limit !== null) {
          const going = await queryOne<{ count: number }>(
            tx,
            "SELECT count(*) AS count FROM rsvps WHERE plan_id = $1 AND state IN ('going', 'checked_in')",
            [id],
          );
          const alreadyGoing = await queryOne<{ state: string }>(
            tx,
            "SELECT state FROM rsvps WHERE plan_id = $1 AND user_id = $2",
            [id, user.id],
          );
          const countsTowardLimit = alreadyGoing?.state !== "going" && alreadyGoing?.state !== "checked_in";
          if (countsTowardLimit && (going?.count ?? 0) >= plan.participant_limit) {
            next = "waitlisted";
          }
        }

        await tx.query(
          `INSERT INTO rsvps (plan_id, user_id, state) VALUES ($1, $2, $3)
           ON CONFLICT (plan_id, user_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [id, user.id, next],
        );
        return { state: next, circleId: plan.circle_id };
      });
      await notifyCircle(ctx, circleId, user.id, "plan.rsvp_updated", id, {
        userId: user.id,
        state,
      });
      trackSafe(ctx.pool, { name: "rsvp_updated", userId: user.id, properties: { entityType: "plan", entityId: id, result: state } });
      return { state };
    });

    app.patch("/v1/plans/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(
        createPlanSchema.partial().omit({ circleId: true }),
        req.body,
      );
      const plan = await queryOne<{ circle_id: string; organizer_id: string; state: string }>(
        ctx.pool,
        "SELECT circle_id, organizer_id, state FROM plans WHERE id = $1",
        [id],
      );
      if (!plan) throw ApiError.notFound("Plan not found");
      const role = await requireCircleMember(ctx.pool, plan.circle_id, user.id);
      if (plan.organizer_id !== user.id && role !== "owner" && role !== "admin") {
        throw ApiError.forbidden("Only the organizer or a Circle admin can change this plan");
      }
      const sets: string[] = [];
      const values: unknown[] = [id];
      const map: Record<string, string> = {
        title: "title",
        description: "description",
        timezone: "timezone",
        place: "place",
        onlineUrl: "online_url",
        budgetAmount: "budget_amount",
        budgetCurrency: "budget_currency",
        participantLimit: "participant_limit",
        cancellationPolicy: "cancellation_policy",
      };
      for (const [key, column] of Object.entries(map)) {
        const value = (input as Record<string, unknown>)[key];
        if (value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (input.startsAt) {
        values.push(new Date(input.startsAt));
        sets.push(`starts_at = $${values.length}`);
      }
      if (sets.length === 0) throw ApiError.badRequest("No plan fields supplied");
      sets.push("updated_at = now()");
      await ctx.pool.query(`UPDATE plans SET ${sets.join(", ")} WHERE id = $1`, values);
      await notifyCircle(ctx, plan.circle_id, user.id, "plan.changed", id, { changedBy: user.id });
      return { ok: true };
    });

    app.post("/v1/plans/:id/cancel", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const plan = await queryOne<{ circle_id: string; organizer_id: string }>(
        ctx.pool,
        "SELECT circle_id, organizer_id FROM plans WHERE id = $1",
        [id],
      );
      if (!plan) throw ApiError.notFound("Plan not found");
      const role = await requireCircleMember(ctx.pool, plan.circle_id, user.id);
      if (plan.organizer_id !== user.id && role !== "owner" && role !== "admin") throw ApiError.forbidden();
      await ctx.pool.query("UPDATE plans SET state = 'cancelled', updated_at = now() WHERE id = $1", [id]);
      await notifyCircle(ctx, plan.circle_id, user.id, "plan.cancelled", id, {});
      return { ok: true };
    });
  };
}
