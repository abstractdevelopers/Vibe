import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { queryMany } from "../db.js";
import { parse, requireUser, type AppContext } from "../http.js";

/**
 * Push notification boundary.
 *
 * Push is not the source of truth: notifications are already durable rows in
 * the `notifications` table. This module only registers device tokens and
 * exposes a delivery seam. No real push provider is configured, so the stub
 * records intent and sends nothing — the honest default per the spec's VERIFY
 * rule. Wiring a provider (APNs/FCM) means implementing `PushSender` and
 * selecting it here.
 */

const registerSchema = z.object({
  platform: z.enum(["ios", "android", "web"]),
  token: z.string().min(8).max(500),
});

const unregisterSchema = z.object({ token: z.string().min(8).max(500) });

export interface PushSender {
  readonly name: string;
  send(deviceTokens: string[], payload: { title: string; body: string }): Promise<void>;
}

/** Default: no external delivery. It logs nothing sensitive and never throws. */
export class StubPushSender implements PushSender {
  readonly name = "stub";
  async send(): Promise<void> {
    /* no provider configured; delivery is a no-op by design */
  }
}

export function pushRoutes(ctx: AppContext) {
  const sender: PushSender = new StubPushSender();
  return async function register(app: FastifyInstance): Promise<void> {
    app.post("/v1/push/devices", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const input = parse(registerSchema, req.body);
      await ctx.pool.query(
        `INSERT INTO device_tokens (user_id, platform, token)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, token) DO UPDATE SET last_seen_at = now(), platform = EXCLUDED.platform`,
        [user.id, input.platform, input.token],
      );
      reply.code(201);
      return { registered: true };
    });

    app.post("/v1/push/devices/unregister", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(unregisterSchema, req.body);
      await ctx.pool.query("DELETE FROM device_tokens WHERE user_id = $1 AND token = $2", [user.id, input.token]);
      return { removed: true };
    });

    /** My registered devices, so Settings can show and manage them. */
    app.get("/v1/push/devices", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        "SELECT platform, token, last_seen_at FROM device_tokens WHERE user_id = $1 ORDER BY last_seen_at DESC",
        [user.id],
      );
      return {
        devices: rows.map((d) => ({
          platform: d.platform,
          // Never echo the full token back; a short fingerprint is enough to
          // recognise a device in the UI.
          tokenHint: String(d.token).slice(-6),
          lastSeenAt: d.last_seen_at,
        })),
        deliveryProvider: sender.name,
      };
    });
  };
}
