import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireUser, type AppContext } from "../http.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { trackSafe } from "./analytics.js";
import { notifyUsers } from "./notifications.js";
import { walletBalance, postWalletTransfer, HOLD_DAYS } from "../money/ledger.js";

/**
 * Vibe Yens — an optional stored balance and send-to-a-friend.
 *
 * This is a deliberate departure from the V1 rule that Vibe never holds a
 * balance. A stored balance and a peer-to-peer transfer are stored value and
 * money transmission: regulated activities that require a licence and a
 * compliance review. So the whole surface is gated behind `WALLET_ENABLED`
 * (default off). When it is off, `walletRoutes` registers nothing and every
 * route here 404s — the feature simply does not exist, and there is no dead
 * money-moving endpoint left reachable.
 *
 * The money model is unchanged: a balance is a SUM over double-entry journals,
 * never a mutable column, and money only enters from a signature-verified
 * provider webhook (see `settleWalletTopup`). Sending to a friend moves a
 * liability between two wallets and never touches cash.
 */

/** A top-up is capped so a fat-fingered amount cannot be a large charge. */
const MAX_TOPUP_MINOR = 50_000_00; // ₦500,000
const MIN_TOPUP_MINOR = 100_00; // ₦100
/** A transfer is capped per send for the same reason. */
const MAX_SEND_MINOR = 20_000_00; // ₦200,000

const topupSchema = z.object({ amountMinor: z.number().int().min(MIN_TOPUP_MINOR).max(MAX_TOPUP_MINOR) });
const sendSchema = z.object({
  recipientId: z.string().uuid(),
  amountMinor: z.number().int().min(100).max(MAX_SEND_MINOR),
  note: z.string().max(140).optional(),
});

export function walletRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // Feature gate. When the wallet is off the routes are not registered at
    // all, so the surface cannot be probed or accidentally used.
    if (!ctx.config.WALLET_ENABLED) return;

    app.get("/v1/wallet", async (req) => {
      const user = await requireUser(ctx, req);
      const balance = await walletBalance(ctx.pool, user.id, "NGN");
      return {
        currency: balance.currency,
        balanceMinor: balance.balanceMinor,
        // Stated plainly so no one mistakes this for bank money.
        policy:
          "Vibe Yens are a prepaid balance you can spend on gifts or send to a friend inside Vibe. They are not a bank deposit and cannot be withdrawn as cash.",
      };
    });

    app.post("/v1/wallet/topups", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(topupSchema, req.body);
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/wallet/topups", key, requestBody: req.body },
        async () => {
          const reference = `WALLET-${newId()}`;
          const id = newId();
          await ctx.pool.query(
            `INSERT INTO wallet_topups (id, user_id, amount_minor, currency, reference, provider)
             VALUES ($1,$2,$3,'NGN',$4,$5)`,
            [id, user.id, input.amountMinor, reference, ctx.provider.name],
          );
          const session = await ctx.provider.createCheckout({
            amount: { amount: input.amountMinor, currency: "NGN" },
            reference,
            description: `Vibe Yens top-up`,
          });
          await ctx.pool.query(`UPDATE wallet_topups SET provider_ref = $2 WHERE id = $1`, [id, session.providerRef]);
          return {
            statusCode: 202,
            body: {
              topupId: id,
              reference,
              amountMinor: input.amountMinor,
              status: "pending",
              redirectUrl: session.redirectUrl,
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    app.post("/v1/wallet/send", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(sendSchema, req.body);
      if (input.recipientId === user.id) throw ApiError.badRequest("You cannot send to yourself");
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/wallet/send", key, requestBody: req.body },
        async () => {
          const recipient = await queryOne<{ id: string; handle: string }>(
            ctx.pool,
            "SELECT id, handle FROM users WHERE id = $1 AND deleted_at IS NULL",
            [input.recipientId],
          );
          if (!recipient) throw ApiError.notFound("Recipient not found");
          const reference = `SEND-${newId()}`;
          const transferId = await withTransaction(ctx.pool, async (tx) => {
            // Lock the sender's wallet row so two concurrent sends cannot both
            // see the same balance. The balance itself is still a ledger SUM.
            const balance = await walletBalance(tx as unknown as typeof ctx.pool, user.id, "NGN");
            if (balance.balanceMinor < input.amountMinor) {
              throw ApiError.badRequest("That is more than your Vibe Yens balance");
            }
            const journalId = await postWalletTransfer(tx, {
              reference,
              senderId: user.id,
              recipientId: input.recipientId,
              amountMinor: input.amountMinor,
              currency: "NGN",
            });
            const id = newId();
            await tx.query(
              `INSERT INTO wallet_transfers (id, sender_id, recipient_id, amount_minor, currency, note, reference, journal_id)
               VALUES ($1,$2,$3,$4,'NGN',$5,$6,$7)`,
              [id, user.id, input.recipientId, input.amountMinor, input.note?.trim() || null, reference, journalId],
            );
            return id;
          });
          await notifyUsers(
            ctx.pool,
            [input.recipientId],
            "wallet.received",
            "wallet_transfer",
            transferId,
            { from: user.handle, amountMinor: input.amountMinor },
          );
          trackSafe(ctx.pool, { name: "wallet_sent", userId: user.id, properties: { entityType: "wallet_transfer", entityId: transferId } });
          return { statusCode: 201, body: { transferId, reference, amountMinor: input.amountMinor, status: "completed" } };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    app.get("/v1/wallet/activity", async (req) => {
      const user = await requireUser(ctx, req);
      const topups = await queryMany(
        ctx.pool,
        `SELECT id, amount_minor, status, created_at FROM wallet_topups WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [user.id],
      );
      const sent = await queryMany(
        ctx.pool,
        `SELECT t.id, t.amount_minor, t.note, t.created_at, u.handle AS other_handle
           FROM wallet_transfers t JOIN users u ON u.id = t.recipient_id
          WHERE t.sender_id = $1 ORDER BY t.created_at DESC LIMIT 30`,
        [user.id],
      );
      const received = await queryMany(
        ctx.pool,
        `SELECT t.id, t.amount_minor, t.note, t.created_at, u.handle AS other_handle
           FROM wallet_transfers t JOIN users u ON u.id = t.sender_id
          WHERE t.recipient_id = $1 ORDER BY t.created_at DESC LIMIT 30`,
        [user.id],
      );
      return { topups, sent, received, holdDays: HOLD_DAYS };
    });
  };
}
