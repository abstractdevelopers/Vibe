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
import { activityRoutes, canAccessRoom } from "./modules/activities-live.js";
import { locationRoutes } from "./modules/location.js";
import { launchRoutes } from "./modules/launch.js";
import { moneyRoutes } from "./modules/money.js";
import { walletRoutes } from "./modules/wallet.js";
import { gameRoutes } from "./modules/games.js";
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

  // Baseline security headers. These are additive and cannot lock anyone out of
  // the server: they only shape what a browser is allowed to do with a response.
  // The API is same-origin with the web client (one image serves both), so the
  // CSP can be strict; media-src allows the blob: URLs the WebRTC audio and
  // banner uploads use, and connect-src allows the wss: realtime socket.
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), geolocation=(self), microphone=(self)");
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob:",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "script-src 'self'",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
    // HSTS only over TLS. Sending it over plain HTTP is meaningless, and pinning
    // it on a deployment that is still HTTP would be a footgun.
    const proto = req.headers["x-forwarded-proto"];
    if (proto === "https") {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

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
  // Readiness carries the one number that matters for realtime scaling: how many
  // sockets this instance is holding. A load balancer or autoscaler can read it.
  app.get("/v1/health/realtime", async () => ({
    status: ctx.hub.atCapacity() ? "at_capacity" : "ok",
    sockets: ctx.hub.socketCount(),
    bus: ctx.config.REALTIME_BUS,
    maxSockets: ctx.config.REALTIME_MAX_SOCKETS,
  }));

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
  await app.register(walletRoutes(ctx));
  await app.register(gameRoutes(ctx));

  // Realtime: chat/poll/plan updates for the circles the user belongs to.
  app.get("/v1/realtime", { websocket: true }, async (socket, req) => {
    // Attach a message handler before the first await. @fastify/websocket does
    // not buffer frames, and the client sends `room.join` the instant the socket
    // opens — which can be while the awaits below are still resolving. Frames
    // that arrive in that window used to be dropped, so the socket was never
    // registered in the room and silently received nothing. Under load, when the
    // session lookup is slow, that is most of them. Buffer instead, and replay
    // once the real handler is installed.
    const pending: Buffer[] = [];
    let handleFrame: ((raw: Buffer) => void) | null = null;
    socket.on("message", (raw: Buffer) => {
      if (handleFrame) handleFrame(raw);
      else if (pending.length < 64) pending.push(raw);
    });

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
    // Load shedding: past the configured ceiling, refuse new sockets with a
    // distinct close code so a client can back off rather than hammer. The
    // process stays healthy and existing calls are unaffected.
    if (ctx.hub.atCapacity()) {
      socket.close(4429, "at capacity");
      return;
    }
    // Bound what one socket can hold and how fast it can talk, so a single
    // client cannot exhaust memory or drown the hub. Signalling frames are tiny;
    // 64 KB is generous.
    const MAX_FRAME_BYTES = 64 * 1024;
    const FRAME_BURST = 60;
    const FRAME_WINDOW_MS = 10_000;
    let frameCount = 0;
    let frameWindowStart = Date.now();

    const circleIds = await circleIdsFor(ctx.pool, user.id);
    const unsubscribe = ctx.hub.subscribe(socket, user.id, circleIds);
    socket.send(JSON.stringify({ type: "realtime.ready", entityId: user.id, payload: { circleIds } }));

    // Inbound frames are only used for room presence and WebRTC signalling.
    // Everything durable (a gift, a message, a stage change) still goes through
    // an HTTP route that authorizes and persists it; the socket never writes.
    //
    // Handling is serialized per socket (`chain`), so a `room.join` that has to
    // check access completes before any signalling frame that follows it is
    // relayed. Without the queue an offer could be published before the socket
    // was registered in the room, and the answer would never arrive.
    let chain: Promise<void> = Promise.resolve();
    handleFrame = (raw: Buffer) => {
      // Flood guard: a well-behaved client sends a handful of frames a second at
      // most (presence + ICE candidates). Anything above the burst is dropped
      // rather than closed, so a transient spike does not kill a live call.
      const now = Date.now();
      if (now - frameWindowStart > FRAME_WINDOW_MS) { frameWindowStart = now; frameCount = 0; }
      frameCount += 1;
      if (frameCount > FRAME_BURST) return;

      const text = raw.toString();
      if (text.length > MAX_FRAME_BYTES) return;
      let msg: { type?: string; roomId?: string; to?: string; payload?: unknown };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg?.type || !msg.roomId) return;

      chain = chain.then(async () => {
        if (msg.type === "room.join") {
          // Authorize before joining: a private room is only for its host and
          // members. Without this any session could listen to any room.
          const allowed = await canAccessRoom(ctx, msg.roomId!, user.id).catch(() => false);
          if (allowed) ctx.hub.joinRoom(socket, msg.roomId!);
          return;
        }
        if (msg.type === "room.leave") {
          ctx.hub.leaveRoom(socket, msg.roomId!);
          return;
        }
        // WebRTC signalling: relay to the room, addressed to one peer. The
        // server is a dumb relay here; it never inspects or stores the SDP/ICE.
        if (msg.type === "rtc.offer" || msg.type === "rtc.answer" || msg.type === "rtc.ice") {
          ctx.hub.publishToRoom(
            msg.roomId!,
            { type: msg.type, entityId: msg.roomId!, payload: { from: user.id, to: msg.to, data: msg.payload } },
            socket,
          );
        }
      }).catch(() => undefined);
    };
    for (const raw of pending) handleFrame(raw);
    pending.length = 0;

    socket.on("close", () => {
      unsubscribe();
    });
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
