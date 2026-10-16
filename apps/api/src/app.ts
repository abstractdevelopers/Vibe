import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { messagingRoutes } from "./modules/messaging.js";
import { giftsRoutes } from "./modules/gifts.js";
import { accountRoutes } from "./modules/account.js";
import { analyticsRoutes } from "./modules/analytics.js";
import { commerceRoutes } from "./modules/commerce.js";
import { advertisingRoutes } from "./modules/advertising.js";
import { adsRoutes } from "./modules/ads.js";
import { eventsRoutes } from "./modules/events.js";
import { adminRoutes } from "./modules/admin.js";
import { passRoutes } from "./modules/pass.js";
import { aiRoutes } from "./modules/ai.js";
import { pushRoutes } from "./modules/push.js";
import { searchRoutes } from "./modules/search.js";
import { activityRoutes } from "./modules/activities-live.js";
import { locationRoutes } from "./modules/location.js";
import { launchRoutes } from "./modules/launch.js";
import { moneyRoutes } from "./modules/money.js";
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

  // Webhook signatures are computed over the exact bytes Bachs sent. Fastify's
  // JSON parser discards those bytes, so capture them on the webhook path only
  // and keep the parsed body too.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = body as string;
    (req as { rawBody?: string }).rawBody = raw;
    // An empty body (a POST with no payload) is not an error; Fastify's default
    // parser treats it as an empty object, so match that.
    if (!raw || raw.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

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
    // A malformed id in a path is a client mistake, not a server fault. Routes
    // take `:id` straight from the URL and pass it to Postgres, so a non-UUID
    // reaches the database and comes back as "invalid input syntax for type
    // uuid". That is a 404 — the thing named by that id does not exist — not a
    // 500. Handling it here covers every route rather than 77 call sites.
    const pgCode = (error as { code?: string }).code;
    if (pgCode === "22P02") {
      const apiError = new ApiError("not_found", "Not found");
      reply.code(apiError.status).send(errorBody(apiError, req.id));
      return;
    }
    req.log.error(error);
    const apiError = new ApiError("internal_error", "Something went wrong");
    reply.code(apiError.status).send(errorBody(apiError, req.id));
  });

  app.get("/health", async () => ({ status: "ok", provider: ctx.provider.name }));
  app.get("/v1/health", async () => ({ status: "ok" }));

  // Publish a machine-readable route index. Every route is registered through
  // this hook, so the document cannot drift from the code. Request/response
  // body schemas are enforced by zod at the boundary; this documents the
  // surface, methods and auth expectation.
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (route) => {
    const method = Array.isArray(route.method) ? route.method.join(",") : route.method;
    if (method === "HEAD" || method === "OPTIONS") return;
    routes.push({ method, url: route.url });
  });
  app.get("/v1/openapi.json", async () => {
    const paths: Record<string, Record<string, unknown>> = {};
    // Fastify writes params as `:id`; OpenAPI uses `{id}`.
    const toOpenApiPath = (url: string) => url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    for (const r of routes.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))) {
      const methods = r.method.split(",");
      const url = toOpenApiPath(r.url);
      for (const m of methods) {
        if (m === "GET" && r.url === "/v1/openapi.json") continue;
        paths[url] ??= {};
        paths[url]![m.toLowerCase()] = {
          summary: `${m} ${url}`,
          // Admin and auth-gated surfaces expect a bearer session; keeping this
          // coarse is honest — the real authorization is enforced per request.
          security: url.startsWith("/v1/admin") ? [{ bearerAuth: [] }] : [],
        };
      }
    }
    return {
      openapi: "3.1.0",
      info: { title: "Vibe API", version: "1.0.0", description: "Interactive social network — conversations into activities, plans and commerce." },
      servers: [{ url: ctx.config.PUBLIC_API_URL }],
      components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
      paths,
    };
  });

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
  await app.register(messagingRoutes(ctx));
  await app.register(giftsRoutes(ctx));
  await app.register(accountRoutes(ctx));
  await app.register(analyticsRoutes(ctx));
  await app.register(commerceRoutes(ctx));
  await app.register(advertisingRoutes(ctx));
  await app.register(adsRoutes(ctx));
  await app.register(eventsRoutes(ctx));
  await app.register(adminRoutes(ctx));
  await app.register(passRoutes(ctx));
  await app.register(aiRoutes(ctx));
  await app.register(pushRoutes(ctx));
  await app.register(searchRoutes(ctx));
  await app.register(activityRoutes(ctx));
  await app.register(locationRoutes(ctx));
  await app.register(launchRoutes(ctx));
  await app.register(moneyRoutes(ctx));

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

  // When the web client has been built into the image, serve it from the same
  // origin as the API so one artefact covers both tiers. In development the
  // client is normally served by Vite on its own port and this is skipped
  // because no build exists yet.
  const webDist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    // SPA fallback: any non-API GET returns index.html so client routing works.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/v1/") && !req.url.startsWith("/health")) {
        reply.sendFile("index.html");
        return;
      }
      reply.code(404).send({ error: { code: "not_found", message: "Not found", requestId: req.id } });
    });
  }

  return app;
}
