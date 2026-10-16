import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireCircleMember } from "./access.js";
import { createAssistProvider } from "../ai/provider.js";

/**
 * AI assistance routes (§4.10).
 *
 * Every response is a *suggestion*, labelled as generated, that the person can
 * accept, correct or dismiss. Accepting records intent only — it does not create
 * a plan, send a message, or move money. That keeps the spec's rule: an AI
 * cannot take a consequential action without explicit, separate confirmation.
 *
 * The facts handed to the provider are gathered here, already authorized, and
 * are limited to counts and names — never message bodies or payment data.
 */

const proposeSchema = z.object({
  kind: z.enum(["draft_plan", "summarize_circle", "suggest_events", "propose_budget", "reminder"]),
  entityId: z.string().uuid().optional(),
  prompt: z.string().max(500).optional(),
  totalMinor: z.number().int().nonnegative().optional(),
  people: z.number().int().positive().optional(),
});

export function aiRoutes(ctx: AppContext) {
  const provider = createAssistProvider("stub");
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/assist/propose", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(proposeSchema, req.body);

      const facts: Record<string, unknown> = {};
      if (input.kind === "summarize_circle") {
        if (!input.entityId) throw ApiError.badRequest("entityId (a Circle) is required to summarize a Circle");
        await requireCircleMember(ctx.pool, input.entityId, user.id);
        const members = await queryOne<{ n: number }>(
          ctx.pool,
          "SELECT count(*) AS n FROM circle_members WHERE circle_id = $1",
          [input.entityId],
        );
        facts.memberCount = members?.n ?? 0;
        const plans = await queryOne<{ n: number }>(
          ctx.pool,
          "SELECT count(*) AS n FROM plans WHERE circle_id = $1 AND state NOT IN ('completed', 'cancelled')",
          [input.entityId],
        );
        facts.openPlans = plans?.n ?? 0;
        const outstanding = await queryOne<{ total: number | null }>(
          ctx.pool,
          `SELECT COALESCE(sum(e.amount_minor), 0) AS total
             FROM expenses e WHERE e.circle_id = $1 AND e.status <> 'settled'`,
          [input.entityId],
        );
        facts.outstandingMinor = outstanding?.total ?? 0;
      }
      if (input.kind === "draft_plan" && input.entityId) {
        await requireCircleMember(ctx.pool, input.entityId, user.id);
      }
      if (input.kind === "suggest_events") {
        const me = await queryOne<{ city: string | null }>(ctx.pool, "SELECT city FROM users WHERE id = $1", [user.id]);
        if (me?.city) facts.city = me.city;
      }
      if (input.kind === "propose_budget") {
        facts.totalMinor = input.totalMinor ?? 0;
        facts.people = input.people ?? 1;
      }

      const suggestion = await provider.propose({ kind: input.kind, prompt: input.prompt, facts });
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        `INSERT INTO ai_suggestions (id, user_id, kind, entity_type, entity_id, prompt, output, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          newId(), user.id, input.kind,
          input.entityId ? "circle" : null, input.entityId ?? null,
          input.prompt ?? null, JSON.stringify(suggestion), provider.name,
        ],
      );
      reply.code(201);
      return {
        id: created!.id,
        kind: input.kind,
        // Labelled, as the spec requires, so the client can show it is generated.
        generated: true,
        provider: provider.name,
        title: suggestion.title,
        body: suggestion.body,
        fields: suggestion.fields ?? {},
        status: "proposed",
      };
    });

    app.get("/v1/assist/suggestions", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, kind, prompt, output, status, provider, created_at
           FROM ai_suggestions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [user.id],
      );
      return {
        suggestions: rows.map((s) => ({
          id: s.id,
          kind: s.kind,
          prompt: s.prompt,
          output: s.output,
          status: s.status,
          provider: s.provider,
          createdAt: s.created_at,
        })),
      };
    });

    /** Record that the person accepted a suggestion. This creates nothing. */
    app.post("/v1/assist/suggestions/:id/accept", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const res = await ctx.pool.query(
        "UPDATE ai_suggestions SET status = 'accepted' WHERE id = $1 AND user_id = $2 AND status = 'proposed'",
        [id, user.id],
      );
      if ((res.rowCount ?? 0) === 0) throw ApiError.notFound("No open suggestion with that id");
      return { id, status: "accepted" };
    });

    app.post("/v1/assist/suggestions/:id/dismiss", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const res = await ctx.pool.query(
        "UPDATE ai_suggestions SET status = 'dismissed' WHERE id = $1 AND user_id = $2 AND status = 'proposed'",
        [id, user.id],
      );
      if ((res.rowCount ?? 0) === 0) throw ApiError.notFound("No open suggestion with that id");
      return { id, status: "dismissed" };
    });
  };
}
