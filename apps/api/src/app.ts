import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ApiError, errorBody } from "./errors.js";
import type { AppContext } from "./http.js";
import { identityRoutes } from "./modules/identity.js";
import { circlesRoutes } from "./modules/circles.js";
import { feedRoutes } from "./modules/feed.js";
import { activitiesRoutes } from "./modules/activities.js";
import { plansRoutes } from "./modules/plans.js";
import { expensesRoutes } from "./modules/expenses.js";
import { socialRoutes } from "./modules/social.js";
import { moderationRoutes } from "./modules/moderation.js";
import { notificationsRoutes } from "./modules/notifications.js";
import { paymentsRoutes } from "./modules/payments.js";
import { mediaRoutes } from "./modules/media.js";
import { discoveryRoutes } from "./modules/discovery.js";
import { resolveSession } from "./auth.js";
import { bearerToken } from "./auth.js";
import { circleIdsFor } from "./modules/access.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: ctx.config.NODE_ENV === "test" ? false : { level: "info" },
    trustProxy: true,
  });

  await app.register(cors, { origin: ctx.config.CORS_ORIGIN === "*" ? true : ctx.config.CORS_ORIGIN });
  await app.register(websocket);

  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (error instanceof ApiError) {
      reply.code(error.status).send(errorBody(error, req.id));
      return;
    }
    if (error.validation) {
      const apiError = new ApiError("validation_error", error.message);
      reply.code(apiError.status).send(errorBody(apiError, req.id));
      return;
    }
    req.log.error(error);
    const apiError = new ApiError("internal_error", "Something went wrong");
    reply.code(apiError.status).send(errorBody(apiError, req.id));
  });

  app.get("/health", async () => ({ status: "ok", provider: ctx.provider.name }));
  app.get("/v1/health", async () => ({ status: "ok" }));

  await app.register(identityRoutes(ctx));
  await app.register(circlesRoutes(ctx));
  await app.register(feedRoutes(ctx));
  await app.register(activitiesRoutes(ctx));
  await app.register(plansRoutes(ctx));
  await app.register(expensesRoutes(ctx));
  await app.register(socialRoutes(ctx));
  await app.register(moderationRoutes(ctx));
  await app.register(notificationsRoutes(ctx));
  await app.register(paymentsRoutes(ctx));
  await app.register(mediaRoutes(ctx));
  await app.register(discoveryRoutes(ctx));

  // Realtime: chat/poll/plan updates for the circles the user belongs to.
  app.get("/v1/realtime", { websocket: true }, async (socket, req) => {
    const token = bearerToken(req.headers.authorization) ?? (req.query as { token?: string }).token;
    if (!token) {
      socket.close(4401, "unauthorized");
      return;
    }
    const user = await resolveSession(ctx.pool, token);
    if (!user) {
      socket.close(4401, "unauthorized");
      return;
    }
    const circleIds = await circleIdsFor(ctx.pool, user.id);
    const unsubscribe = ctx.hub.subscribe(socket, user.id, circleIds);
    socket.send(JSON.stringify({ type: "realtime.ready", entityId: user.id, payload: { circleIds } }));
    socket.on("close", unsubscribe);
  });

  return app;
}
