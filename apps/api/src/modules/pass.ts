import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId, newToken } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { trackSafe } from "./analytics.js";

/**
 * Vibe Pass and IRL loyalty (§4.9, Phase 5).
 *
 * The pass is a revocable pointer. The NFC tag / QR carries only a random
 * public token; the server resolves it to the pass row. Nothing personal or
 * payment-related is ever written to the tag, and the holder chooses what
 * profile data a scan may reveal.
 *
 * Loyalty redemption is merchant-authorized and duplicate-protected: a nonce
 * makes each redemption single-use, so replaying the same scan cannot redeem
 * an offer twice.
 */

const shareSchema = z.object({
  shareDisplayName: z.boolean().optional(),
  shareAvatar: z.boolean().optional(),
  shareHandle: z.boolean().optional(),
});

const redeemSchema = z.object({
  passToken: z.string().min(4).max(200),
  offerCode: z.string().min(1).max(80),
  nonce: z.string().min(8).max(120),
});

/** Public shape returned when a merchant scans a pass. Honours share consent. */
function publicPassView(p: {
  public_token: string; status: string; share_display_name: boolean; share_avatar: boolean;
  share_handle: boolean; display_name: string; avatar_url: string | null; handle: string;
}) {
  return {
    token: p.public_token,
    status: p.status,
    // Only the fields the holder agreed to share.
    displayName: p.share_display_name ? p.display_name : null,
    avatarUrl: p.share_avatar ? p.avatar_url : null,
    handle: p.share_handle ? p.handle : null,
  };
}

export function passRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    /** Create or fetch my pass. One active pass per user. */
    app.post("/v1/pass", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const existing = await queryOne<{ id: string; public_token: string; status: string }>(
        ctx.pool,
        "SELECT id, public_token, status FROM vibe_passes WHERE user_id = $1 AND status = 'active' LIMIT 1",
        [user.id],
      );
      if (existing) return { id: existing.id, token: existing.public_token, status: existing.status };
      const token = newToken(18);
      const created = await queryOne<{ id: string }>(
        ctx.pool,
        "INSERT INTO vibe_passes (id, user_id, public_token) VALUES ($1, $2, $3) RETURNING id",
        [newId(), user.id, token],
      );
      reply.code(201);
      return { id: created!.id, token, status: "active" };
    });

    app.get("/v1/pass/me", async (req) => {
      const user = await requireUser(ctx, req);
      const p = await queryOne<{
        id: string; public_token: string; status: string; share_display_name: boolean;
        share_avatar: boolean; share_handle: boolean; created_at: Date;
      }>(
        ctx.pool,
        "SELECT id, public_token, status, share_display_name, share_avatar, share_handle, created_at FROM vibe_passes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
        [user.id],
      );
      if (!p) return { pass: null };
      return {
        pass: {
          id: p.id,
          token: p.public_token,
          status: p.status,
          share: { displayName: p.share_display_name, avatar: p.share_avatar, handle: p.share_handle },
          createdAt: p.created_at,
        },
      };
    });

    app.patch("/v1/pass/me/share", async (req) => {
      const user = await requireUser(ctx, req);
      const input = parse(shareSchema, req.body ?? {});
      const p = await queryOne<{ id: string }>(
        ctx.pool,
        "SELECT id FROM vibe_passes WHERE user_id = $1 AND status = 'active' LIMIT 1",
        [user.id],
      );
      if (!p) throw ApiError.notFound("You do not have an active pass");
      await ctx.pool.query(
        `UPDATE vibe_passes SET
           share_display_name = COALESCE($2, share_display_name),
           share_avatar = COALESCE($3, share_avatar),
           share_handle = COALESCE($4, share_handle),
           updated_at = now()
         WHERE id = $1`,
        [p.id, input.shareDisplayName ?? null, input.shareAvatar ?? null, input.shareHandle ?? null],
      );
      return { ok: true };
    });

    /** Revoke my pass. The old token stops resolving immediately. */
    app.post("/v1/pass/me/revoke", async (req) => {
      const user = await requireUser(ctx, req);
      const res = await ctx.pool.query(
        "UPDATE vibe_passes SET status = 'revoked', updated_at = now() WHERE user_id = $1 AND status = 'active'",
        [user.id],
      );
      if ((res.rowCount ?? 0) === 0) throw ApiError.notFound("No active pass to revoke");
      return { revoked: true };
    });

    /**
     * Resolve a scanned pass token. This is the merchant-facing read. A revoked
     * or unknown token returns nothing — the pointer is dead.
     */
    app.get("/v1/pass/resolve/:token", async (req) => {
      await requireUser(ctx, req);
      const { token } = req.params as { token: string };
      const p = await queryOne<{
        public_token: string; status: string; share_display_name: boolean; share_avatar: boolean;
        share_handle: boolean; display_name: string; avatar_url: string | null; handle: string;
      }>(
        ctx.pool,
        `SELECT p.public_token, p.status, p.share_display_name, p.share_avatar, p.share_handle,
                u.display_name, u.avatar_url, u.handle
           FROM vibe_passes p JOIN users u ON u.id = p.user_id
          WHERE p.public_token = $1 AND p.status = 'active'`,
        [token],
      );
      if (!p) throw ApiError.notFound("That pass is not valid");
      return { pass: publicPassView(p) };
    });

    /**
     * Redeem a loyalty offer against a pass, authorized by the merchant who
     * owns it. The nonce makes the redemption single-use.
     */
    app.post("/v1/merchants/:id/redeem", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const input = parse(redeemSchema, req.body);
      const merchant = await queryOne<{ owner_id: string }>(
        ctx.pool,
        "SELECT owner_id FROM merchants WHERE id = $1",
        [id],
      );
      if (!merchant) throw ApiError.notFound("Merchant not found");
      if (merchant.owner_id !== user.id && !user.isAdmin) {
        throw ApiError.forbidden("Only the merchant can redeem loyalty offers");
      }
      const pass = await queryOne<{ id: string; status: string }>(
        ctx.pool,
        "SELECT id, status FROM vibe_passes WHERE public_token = $1",
        [input.passToken],
      );
      if (!pass || pass.status !== "active") throw ApiError.badRequest("That pass is not valid");

      const result = await withTransaction(ctx.pool, async (tx) => {
        // The unique constraint is the duplicate guard: a replayed nonce fails
        // the insert rather than creating a second redemption.
        const inserted = await tx.query(
          `INSERT INTO loyalty_redemptions (id, pass_id, merchant_id, offer_code, nonce, status, redeemed_at)
           VALUES ($1, $2, $3, $4, $5, 'redeemed', now())
           ON CONFLICT (pass_id, merchant_id, offer_code, nonce) DO NOTHING
           RETURNING id`,
          [newId(), pass.id, id, input.offerCode, input.nonce],
        );
        return (inserted.rowCount ?? 0) > 0;
      });
      if (!result) {
        // Already redeemed with this nonce — idempotent success, not a new one.
        return { redeemed: true, duplicate: true };
      }
      trackSafe(ctx.pool, { name: "offer_redeemed", userId: user.id, properties: { entityType: "merchant", entityId: id, kind: input.offerCode } });
      reply.code(201);
      return { redeemed: true, duplicate: false };
    });

    /** A merchant's redemption history. */
    app.get("/v1/merchants/:id/redemptions", async (req) => {
      const user = await requireUser(ctx, req);
      const { id } = req.params as { id: string };
      const merchant = await queryOne<{ owner_id: string }>(
        ctx.pool,
        "SELECT owner_id FROM merchants WHERE id = $1",
        [id],
      );
      if (!merchant) throw ApiError.notFound("Merchant not found");
      if (merchant.owner_id !== user.id && !user.isAdmin) throw ApiError.forbidden("Not allowed");
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, offer_code, status, redeemed_at, created_at
           FROM loyalty_redemptions WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id],
      );
      return {
        redemptions: rows.map((r) => ({
          id: r.id,
          offerCode: r.offer_code,
          status: r.status,
          redeemedAt: r.redeemed_at,
          createdAt: r.created_at,
        })),
      };
    });
  };
}
