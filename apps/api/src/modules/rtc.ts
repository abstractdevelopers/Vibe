import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../http.js";

/**
 * ICE server configuration.
 *
 * A browser needs more than STUN to connect two peers reliably: when both sit
 * behind symmetric or carrier-grade NAT there is no direct path, and only a TURN
 * relay works. Credentials are minted here, short-lived, from a shared secret
 * that never leaves the server — the "REST API" scheme coturn understands:
 * username is `<expiry>:<user>`, password is base64(HMAC-SHA1(secret, username)).
 *
 * Returning them per request means a leaked response is useless within the TTL,
 * and the secret is never baked into the client bundle.
 */

interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** coturn's time-limited credential, derived from the shared secret. */
export function turnCredentials(secret: string, ttlSeconds: number, user: string, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + ttlSeconds;
  const username = `${expiry}:${user}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiry };
}

export function iceServersFor(ctx: AppContext, user: string): IceServer[] {
  const servers: IceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
  ];
  const urls = (ctx.config.TURN_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const secret = ctx.config.TURN_SECRET;
  if (urls.length > 0 && secret) {
    const { username, credential } = turnCredentials(secret, ctx.config.TURN_TTL_SECONDS, user);
    servers.push({ urls: urls.length === 1 ? urls[0]! : urls, username, credential });
  }
  return servers;
}

export function rtcRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // Authenticated: credentials are per-user and short-lived, so an anonymous
    // caller gets nothing to relay with.
    app.get("/v1/rtc/ice", async (req) => {
      const user = await requireUser(ctx, req);
      return { iceServers: iceServersFor(ctx, user.id) };
    });
  };
}
