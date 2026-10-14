import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireCircleMember } from "./access.js";
import { trackSafe } from "./analytics.js";

const createPollSchema = z.object({
  question: z.string().min(1).max(300),
  options: z.array(z.string().min(1).max(120)).min(2).max(10),
  circleId: z.string().uuid().optional(),
  endsAt: z.string().datetime().optional(),
});

const voteSchema = z.object({ optionId: z.string().uuid() });

async function pollState(db: AppContext["pool"], activityId: string) {
  const activity = await queryOne<{ id: string; state: string; post_id: string; circle_id: string | null; ends_at: Date | null }>(
    db,
    "SELECT id, state, post_id, circle_id, ends_at FROM activities WHERE id = $1",
    [activityId],
  );
  if (!activity) throw ApiError.notFound("Activity not found");
  const options = await queryMany<{ id: string; label: string; votes: number }>(
    db,
    `SELECT o.id, o.label, (SELECT count(*) FROM votes v WHERE v.option_id = o.id) AS votes
       FROM poll_options o WHERE o.activity_id = $1 ORDER BY o.position`,
    [activityId],
  );
  return {
    id: activity.id,
    state: activity.state,
    postId: activity.post_id,
    circleId: activity.circle_id,
    endsAt: activity.ends_at,
    options: options.map((o) => ({ id: o.id, label: o.label, votes: o.votes })),
    totalVotes: options.reduce((sum, o) => sum + o.votes, 0),
  };
}

/** A poll is votable only while open and before its end time. */
function assertVotable(state: string, endsAt: Date | null): void {
  if (state !== "open") throw ApiError.conflict(`This poll is ${state} and no longer accepts votes`);
  if (endsAt && endsAt.getTime() <= Date.now()) {
    throw ApiError.conflict("This poll has ended");
  }
}

export function activitiesRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/activities", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(createPollSchema, req.body);
      if (input.circleId) await requireCircleMember(ctx.pool, input.circleId, user.id);
      const endsAt = input.endsAt ? new Date(input.endsAt) : null;
      if (endsAt && endsAt.getTime() <= Date.now()) {
        throw ApiError.badRequest("endsAt must be in the future");
      }

      const activityId = await withTransaction(ctx.pool, async (tx) => {
        const post = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO posts (id, author_id, circle_id, type, audience, body, metadata)
           VALUES ($1, $2, $3, 'poll', $4, $5, $6) RETURNING id`,
          [
            newId(),
            user.id,
            input.circleId ?? null,
            input.circleId ? "circle" : "connections",
            input.question,
            JSON.stringify({ question: input.question }),
          ],
        );
        const activity = await queryOne<{ id: string }>(
          tx,
          `INSERT INTO activities (id, post_id, creator_id, circle_id, type, state, ends_at)
           VALUES ($1, $2, $3, $4, 'poll', 'open', $5) RETURNING id`,
          [newId(), post!.id, user.id, input.circleId ?? null, endsAt],
        );
        for (const [index, label] of input.options.entries()) {
          await tx.query(
            "INSERT INTO poll_options (id, activity_id, label, position) VALUES ($1, $2, $3, $4)",
            [newId(), activity!.id, label, index],
          );
        }
        return activity!.id;
      });

      trackSafe(ctx.pool, { name: "activity_created", userId: user.id, properties: { entityType: "activity", entityId: activityId, kind: "poll" } });
      reply.code(201);
      return await pollState(ctx.pool, activityId);
    });

    app.get("/v1/activities/:id", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const state = await pollState(ctx.pool, id);
      if (state.circleId) await requireCircleMember(ctx.pool, state.circleId, user.id);
      const viewerVote = await queryOne<{ option_id: string }>(
        ctx.pool,
        "SELECT option_id FROM votes WHERE activity_id = $1 AND user_id = $2",
        [id, user.id],
      );
      return { ...state, viewerOptionId: viewerVote?.option_id ?? null };
    });

    app.post("/v1/activities/:id/votes", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(voteSchema, req.body);

      const state = await pollState(ctx.pool, id);
      if (state.circleId) await requireCircleMember(ctx.pool, state.circleId, user.id);
      assertVotable(state.state, state.endsAt);

      const option = await queryOne<{ id: string }>(
        ctx.pool,
        "SELECT id FROM poll_options WHERE id = $1 AND activity_id = $2",
        [input.optionId, id],
      );
      if (!option) throw ApiError.badRequest("That option does not belong to this poll");

      // The votes primary key (activity_id, user_id) enforces one vote per user
      // at the database level; a second attempt cannot create a duplicate.
      const inserted = await ctx.pool.query(
        `INSERT INTO votes (activity_id, option_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (activity_id, user_id) DO NOTHING`,
        [id, input.optionId, user.id],
      );
      if (inserted.rowCount === 0) {
        throw ApiError.conflict("You have already voted in this poll");
      }

      trackSafe(ctx.pool, { name: "vote_submitted", userId: user.id, properties: { entityType: "activity", entityId: id } });
      const updated = await pollState(ctx.pool, id);
      const event = { type: "poll.results_updated", entityId: id, payload: updated };
      if (state.circleId) {
        ctx.hub.publishToCircle(state.circleId, event);
      } else {
        ctx.hub.publishToUsers([user.id], event);
      }
      return { ...updated, viewerOptionId: input.optionId };
    });

    app.post("/v1/activities/:id/close", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const activity = await queryOne<{ creator_id: string; state: string; circle_id: string | null }>(
        ctx.pool,
        "SELECT creator_id, state, circle_id FROM activities WHERE id = $1",
        [id],
      );
      if (!activity) throw ApiError.notFound("Activity not found");
      if (activity.creator_id !== user.id && !user.isAdmin) throw ApiError.forbidden();
      if (activity.state !== "open") throw ApiError.conflict(`Cannot close a poll that is ${activity.state}`);
      await ctx.pool.query("UPDATE activities SET state = 'closed', updated_at = now() WHERE id = $1", [id]);
      const state = await pollState(ctx.pool, id);
      if (state.circleId) {
        ctx.hub.publishToCircle(state.circleId, { type: "poll.closed", entityId: id, payload: state });
      }
      return state;
    });

    app.post("/v1/activities/:id/publish-results", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const activity = await queryOne<{ creator_id: string; state: string }>(
        ctx.pool,
        "SELECT creator_id, state FROM activities WHERE id = $1",
        [id],
      );
      if (!activity) throw ApiError.notFound("Activity not found");
      if (activity.creator_id !== user.id && !user.isAdmin) throw ApiError.forbidden();
      if (activity.state !== "closed") {
        throw ApiError.conflict("Close the poll before publishing results");
      }
      await ctx.pool.query("UPDATE activities SET state = 'results_published', updated_at = now() WHERE id = $1", [id]);
      return await pollState(ctx.pool, id);
    });
  };
}
