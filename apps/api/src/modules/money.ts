import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { queryMany, queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { parse, requireAdmin, requireUser, type AppContext } from "../http.js";
import { requireIdempotencyKey, runIdempotent } from "../idempotency.js";
import { trackSafe } from "./analytics.js";
import { GIFT_CATALOGUE, GIFT_FEE_BPS, splitGift } from "../money/catalogue.js";
import { creatorBalance, lockEarningsAccount, postPayout, postPayoutReversal, MIN_PAYOUT_MINOR } from "../money/ledger.js";
import { ProviderError } from "../payments/payouts.js";
import { requirePostVisible } from "./feed.js";
import { canAccessRoom } from "./activities-live.js";

/**
 * Money routes: paid gifts, creator balance, bank accounts and payouts.
 *
 * Two rules are enforced here rather than trusted to the client:
 *   - a price is always read from the gift catalogue in the database, never
 *     from the request body;
 *   - a payout amount is always derived from the ledger, never from the body.
 *
 * A purchase is created `pending`. It becomes `paid` only when a
 * signature-verified provider webhook confirms the charge (see
 * `applyGiftPurchase`), which is also what writes the ledger journal.
 */

const purchaseSchema = z.object({
  giftId: z.string().min(1).max(40),
  quantity: z.number().int().min(1).max(100).default(1),
  recipientId: z.string().uuid(),
  postId: z.string().uuid().optional(),
  // A paid gift can be sent inside a live room as well as on a post.
  roomId: z.string().uuid().optional(),
});

const destinationSchema = z.object({
  accountName: z.string().min(2).max(120),
  // NUBAN is 10 digits. Validated here so an obvious typo never reaches the
  // provider, which charges for a failed transfer.
  accountNumber: z.string().regex(/^\d{10}$/, "A Nigerian account number is 10 digits"),
  bankCode: z.string().min(2).max(10),
  currency: z.string().length(3).default("NGN"),
  label: z.string().min(1).max(60).default("My account"),
});

const payoutSchema = z.object({
  amountMinor: z.number().int().positive().optional(),
  destinationId: z.string().uuid(),
});

/**
 * Payouts are off unless an operator switches them on. Refuse clearly rather
 * than letting the disabled provider throw and surface as a 500 — a creator
 * tapping "Add bank account" should be told withdrawals are not open, not that
 * "something went wrong".
 */
function requirePayoutsEnabled(ctx: AppContext): void {
  if (ctx.payouts.name === "disabled") {
    throw new ApiError(
      "provider_unavailable",
      "Withdrawals are not switched on yet. Your earnings are safe and will be payable soon.",
    );
  }
}

function serializeCatalogue() {
  return GIFT_CATALOGUE.map((g) => ({
    id: g.id,
    label: g.label,
    hint: g.hint,
    emoji: g.emoji,
    tier: g.tier,
    priceMinor: g.priceMinor,
    currency: g.currency,
    // The recipient's share, so the UI can state it plainly.
    recipientMinor: g.priceMinor - splitGift(g.priceMinor, g.feeBps).feeMinor,
  }));
}

export function moneyRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    // ---- Catalogue ----

    app.get("/v1/money/gifts", async (req) => {
      await requireUser(ctx, req);
      return {
        gifts: serializeCatalogue(),
        currency: "NGN",
        feeBps: GIFT_CATALOGUE[0]!.feeBps,
        // Stated plainly: what a buyer pays, what Vibe keeps, what the creator gets.
        // Derived from the same constant the split uses, so the sentence cannot
        // describe a rate the server does not charge.
        policy:
          `A paid gift costs the price shown. Vibe keeps ${GIFT_FEE_BPS / 100}% and the creator earns ${100 - GIFT_FEE_BPS / 100}%, payable to their bank account after a 7-day hold.`,
      };
    });

    // ---- Purchase ----

    app.post("/v1/money/gifts/purchase", async (req, reply) => {
      const user = await requireUser(ctx, req);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(purchaseSchema, req.body);
      if (input.recipientId === user.id) {
        throw ApiError.badRequest("You cannot send a paid gift to yourself");
      }
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/money/gifts/purchase", key, requestBody: req.body },
        async () => {
          const gift = await queryOne<{
            id: string; price_minor: string; currency: string; fee_bps: number; active: boolean;
          }>(
            ctx.pool,
            `SELECT id, price_minor, currency, fee_bps, active FROM gift_catalogue WHERE id = $1`,
            [input.giftId],
          );
          if (!gift || !gift.active) throw ApiError.badRequest("That gift is not available");
          const recipient = await queryOne<{ id: string }>(
            ctx.pool,
            "SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL",
            [input.recipientId],
          );
          if (!recipient) throw ApiError.notFound("Recipient not found");

          // A paid gift must land on something the buyer can actually see, and
          // the money must go to that object's owner. Otherwise the post or
          // room id is decoration on a transfer to an arbitrary account.
          if (input.postId) {
            const post = await requirePostVisible(ctx, input.postId, user.id);
            if (post.author_id !== input.recipientId) {
              throw ApiError.badRequest("A post gift goes to the post's author");
            }
          }
          if (input.roomId) {
            const room = await queryOne<{ host_id: string }>(
              ctx.pool,
              "SELECT host_id FROM activity_rooms WHERE id = $1",
              [input.roomId],
            );
            if (!room) throw ApiError.notFound("Room not found");
            if (room.host_id !== input.recipientId) {
              throw ApiError.badRequest("A room gift goes to the room's host");
            }
            if (!(await canAccessRoom(ctx, input.roomId, user.id))) {
              throw ApiError.forbidden("You cannot gift a room you cannot enter");
            }
          }
          const blocked = await queryOne<{ one: number }>(
            ctx.pool,
            `SELECT 1 AS one FROM blocks
              WHERE (blocker_id = $1 AND blocked_id = $2)
                 OR (blocker_id = $2 AND blocked_id = $1)
              LIMIT 1`,
            [user.id, input.recipientId],
          );
          if (blocked) throw ApiError.forbidden("You cannot gift this user");

          const unitPrice = Number(gift.price_minor);
          const amountMinor = unitPrice * input.quantity;
          const { feeMinor, recipientMinor } = splitGift(amountMinor, gift.fee_bps);
          const reference = `GIFT-${newId()}`;
          const purchaseId = newId();
          await ctx.pool.query(
            `INSERT INTO gift_purchases
               (id, buyer_id, recipient_id, post_id, room_id, gift_id, quantity, unit_price_minor,
                fee_bps, amount_minor, fee_minor, recipient_minor, currency, reference, provider)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              purchaseId, user.id, input.recipientId, input.postId ?? null, input.roomId ?? null,
              gift.id, input.quantity,
              unitPrice, gift.fee_bps, amountMinor, feeMinor, recipientMinor, gift.currency,
              reference, ctx.provider.name,
            ],
          );
          const session = await ctx.provider.createCheckout({
            amount: { amount: amountMinor, currency: gift.currency },
            reference,
            description: `Vibe gift: ${gift.id} x${input.quantity}`,
          });
          await ctx.pool.query(
            "UPDATE gift_purchases SET provider_ref = $2, updated_at = now() WHERE id = $1",
            [purchaseId, session.providerRef],
          );
          return {
            statusCode: 202,
            body: {
              purchaseId,
              reference,
              amountMinor,
              feeMinor,
              recipientMinor,
              currency: gift.currency,
              // Never reported as paid: only a verified webhook can do that.
              status: "pending",
              redirectUrl: session.redirectUrl,
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    // ---- Creator balance and earnings ----

    app.get("/v1/money/balance", async (req) => {
      const user = await requireUser(ctx, req);
      const q = parse(z.object({ currency: z.string().length(3).default("NGN") }), req.query);
      const balance = await creatorBalance(ctx.pool, user.id, q.currency);
      const destinations = await queryMany(
        ctx.pool,
        `SELECT id, bank_name, account_name, account_last4, currency, status, is_default
           FROM payout_destinations WHERE user_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return {
        ...balance,
        // Formatted for display, so the client never does money arithmetic.
        availableFormatted: (balance.availableMinor / 100).toFixed(2),
        destinations,
        payoutProvider: ctx.payouts.name,
      };
    });

    app.get("/v1/money/earnings", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT g.id, g.gift_id, g.quantity, g.created_at, u.handle, u.display_name,
                (p.recipient_minor) AS earned_minor, p.currency
           FROM paid_gifts g
           JOIN gift_purchases p ON p.id = g.purchase_id
           JOIN users u ON u.id = g.sender_id
          WHERE g.recipient_id = $1 ORDER BY g.created_at DESC LIMIT 50`,
        [user.id],
      );
      return { earnings: rows };
    });

    // ---- Payout destinations ----

    app.get("/v1/money/destinations", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT id, bank_name, bank_code, account_name, account_last4, currency, status, is_default, created_at
           FROM payout_destinations WHERE user_id = $1 ORDER BY created_at DESC`,
        [user.id],
      );
      return { destinations: rows, provider: ctx.payouts.name };
    });

    app.post("/v1/money/destinations", async (req, reply) => {
      const user = await requireUser(ctx, req);
      requirePayoutsEnabled(ctx);
      const input = parse(destinationSchema, req.body);
      let destination;
      try {
        destination = await ctx.payouts.createDestination({
          accountName: input.accountName,
          accountNumber: input.accountNumber,
          bankCode: input.bankCode,
          currency: input.currency,
          label: input.label,
        });
      } catch (err) {
        // A rejected bank account is the user's to fix, not a server fault.
        if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
          throw new ApiError("bad_request", err.message);
        }
        throw new ApiError("provider_unavailable", "The bank could not be reached. Please try again.");
      }
      const id = newId();
      const isFirst = (await queryOne<{ n: string }>(
        ctx.pool,
        "SELECT count(*) AS n FROM payout_destinations WHERE user_id = $1 AND currency = $2",
        [user.id, destination.currency],
      ))!.n === "0";
      await ctx.pool.query(
        `INSERT INTO payout_destinations
           (id, user_id, provider, provider_destination_id, bank_name, bank_code, account_name,
            account_last4, currency, status, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id, user.id, ctx.payouts.name, destination.providerDestinationId, destination.bankName,
          destination.bankCode, destination.accountName, destination.accountLast4,
          destination.currency, destination.status, isFirst,
        ],
      );
      trackSafe(ctx.pool, { name: "payout_destination_added", userId: user.id, properties: { entityType: "payout_destination", entityId: id } });
      reply.code(201);
      return {
        id,
        status: destination.status,
        bankName: destination.bankName,
        accountName: destination.accountName,
        accountLast4: destination.accountLast4,
        // The provider reviews a new destination; it cannot be paid until approved.
        note: destination.status === "approved"
          ? "This account is ready for payouts."
          : "Your bank will review this account before it can receive payouts.",
      };
    });

    // ---- Payouts ----

    app.get("/v1/money/payouts", async (req) => {
      const user = await requireUser(ctx, req);
      const rows = await queryMany(
        ctx.pool,
        `SELECT p.id, p.amount_minor, p.currency, p.status, p.failure_reason, p.requested_at,
                p.completed_at, d.bank_name, d.account_last4
           FROM payouts p JOIN payout_destinations d ON d.id = p.destination_id
          WHERE p.user_id = $1 ORDER BY p.requested_at DESC LIMIT 50`,
        [user.id],
      );
      return { payouts: rows };
    });

    app.post("/v1/money/payouts", async (req, reply) => {
      const user = await requireUser(ctx, req);
      requirePayoutsEnabled(ctx);
      const key = requireIdempotencyKey(req.headers["idempotency-key"] as string | undefined);
      const input = parse(payoutSchema, req.body);
      const result = await runIdempotent(
        ctx.pool,
        { userId: user.id, route: "POST /v1/money/payouts", key, requestBody: req.body },
        async () => {
          const destination = await queryOne<{
            id: string; provider_destination_id: string; status: string; currency: string;
          }>(
            ctx.pool,
            `SELECT id, provider_destination_id, status, currency FROM payout_destinations
              WHERE id = $1 AND user_id = $2`,
            [input.destinationId, user.id],
          );
          if (!destination) throw ApiError.notFound("Bank account not found");
          if (destination.status !== "approved") {
            throw ApiError.badRequest("This bank account has not been approved by the bank yet");
          }
          // The amount comes from the ledger, not the request. The earnings
          // account is locked while the balance is read and the reservation is
          // written, so two concurrent requests cannot both see the same
          // available balance and both reserve it.
          const reference = `WD-${newId()}`;
          const payoutId = newId();
          const amountMinor = await withTransaction(ctx.pool, async (tx) => {
            await lockEarningsAccount(tx, user.id, destination.currency);
            const balance = await creatorBalance(tx as unknown as typeof ctx.pool, user.id, destination.currency);
            const amount = input.amountMinor ?? balance.availableMinor;
            if (amount > balance.availableMinor) {
              throw ApiError.badRequest("That is more than your available balance");
            }
            if (amount < MIN_PAYOUT_MINOR) {
              throw ApiError.badRequest(
                `The smallest payout is ${(MIN_PAYOUT_MINOR / 100).toFixed(2)} ${destination.currency}`,
              );
            }
            // Reserve inside the lock: the row is counted by `creatorBalance`
            // before the provider is called.
            await tx.query(
              `INSERT INTO payouts (id, user_id, destination_id, amount_minor, currency, status, provider, reference)
               VALUES ($1,$2,$3,$4,$5,'requested',$6,$7)`,
              [payoutId, user.id, destination.id, amount, destination.currency, ctx.payouts.name, reference],
            );
            return amount;
          });
          let providerResult;
          try {
            providerResult = await ctx.payouts.createPayout({
              providerDestinationId: destination.provider_destination_id,
              amountMinor,
              currency: destination.currency,
              reference,
              narration: "Vibe creator earnings",
            });
          } catch (err) {
            // The provider refused before moving money; release the reservation.
            await ctx.pool.query(
              `UPDATE payouts SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
              [payoutId, err instanceof Error ? err.message.slice(0, 300) : "Provider error"],
            );
            if (err instanceof ProviderError && err.status >= 400 && err.status < 500) {
              throw new ApiError("bad_request", err.message);
            }
            throw new ApiError("provider_unavailable", "The bank could not be reached. Please try again.");
          }
          await ctx.pool.query(
            `UPDATE payouts SET provider_ref = $2, status = $3, updated_at = now() WHERE id = $1`,
            [payoutId, providerResult.providerRef, providerResult.status === "paid" ? "processing" : providerResult.status],
          );
          trackSafe(ctx.pool, {
            name: "payout_requested",
            userId: user.id,
            properties: { entityType: "payout", entityId: payoutId, amountMinor },
          });
          return {
            statusCode: 202,
            body: {
              id: payoutId,
              reference,
              amountMinor,
              currency: destination.currency,
              status: "requested",
              note: "The bank is processing this payout. Your balance updates when it settles.",
            },
          };
        },
      );
      reply.code(result.statusCode);
      return result.body;
    });

    // ---- Operator view ----

    app.get("/v1/admin/money/overview", async (req) => {
      const actor = await requireUser(ctx, req);
      requireAdmin(actor);
      const revenue = await queryOne<{ total: string }>(
        ctx.pool,
        `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS total
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.kind = 'platform_revenue'`,
      );
      const owed = await queryOne<{ total: string }>(
        ctx.pool,
        `SELECT COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor ELSE -e.amount_minor END), 0) AS total
           FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.kind = 'creator_earnings'`,
      );
      const paidOut = await queryOne<{ total: string }>(
        ctx.pool,
        `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payouts WHERE status = 'paid'`,
      );
      const pendingPayouts = await queryMany(
        ctx.pool,
        `SELECT p.id, p.amount_minor, p.currency, p.status, p.requested_at, u.handle, u.email
           FROM payouts p JOIN users u ON u.id = p.user_id
          WHERE p.status IN ('requested', 'processing') ORDER BY p.requested_at LIMIT 50`,
      );
      // The check that matters: every journal must sum to zero. A non-zero row
      // here means money was created or destroyed and needs investigation.
      const unbalanced = await queryMany(
        ctx.pool,
        `SELECT j.id, j.kind, j.currency,
                SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) AS imbalance
           FROM ledger_journals j JOIN ledger_entries e ON e.journal_id = j.id
          GROUP BY j.id, j.kind, j.currency
         HAVING SUM(CASE WHEN e.direction = 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0
          LIMIT 20`,
      );
      return {
        platformRevenueMinor: Number(revenue?.total ?? 0),
        creatorEarningsOwedMinor: Number(owed?.total ?? 0),
        paidOutMinor: Number(paidOut?.total ?? 0),
        pendingPayouts,
        unbalancedJournals: unbalanced,
      };
    });
  };
}
