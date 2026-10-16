import type pg from "pg";
import { queryOne, withTransaction } from "../db.js";
import { newId } from "../ids.js";
import { postGiftPurchase, postGiftRefund, postPayout, postPayoutReversal } from "./ledger.js";

/**
 * Fulfilment: turning a signature-verified provider event into money state.
 *
 * This is the only place a gift becomes paid. It runs inside one transaction
 * with the ledger journal, so either the purchase is paid and the books are
 * balanced, or neither happened. Idempotency is a database constraint: the
 * `paid_gifts.purchase_id` unique index means a redelivered webhook cannot
 * deliver twice, and the caller has already deduplicated on (provider, event_id).
 */

export interface GiftSettlementResult {
  applied: boolean;
  reason?: string;
  purchaseId?: string;
}

/**
 * Apply a verified `payment_succeeded` for a gift purchase.
 * Returns whether anything changed.
 */
export async function settleGiftPurchase(
  pool: pg.Pool,
  input: { reference: string; providerRef: string; paidAmountMinor: number | null },
): Promise<GiftSettlementResult> {
  return withTransaction(pool, async (tx) => {
    const purchase = await queryOne<{
      id: string; buyer_id: string; recipient_id: string; post_id: string | null;
      gift_id: string; quantity: number; amount_minor: string; fee_minor: string;
      currency: string; status: string;
    }>(
      tx as unknown as pg.Pool,
      `SELECT id, buyer_id, recipient_id, post_id, gift_id, quantity, amount_minor, fee_minor, currency, status
         FROM gift_purchases WHERE reference = $1 FOR UPDATE`,
      [input.reference],
    );
    if (!purchase) return { applied: false, reason: "unknown_reference" };
    if (purchase.status === "paid") return { applied: false, reason: "already_paid", purchaseId: purchase.id };
    if (purchase.status !== "pending") return { applied: false, reason: `status_${purchase.status}`, purchaseId: purchase.id };

    // The amount the provider actually collected must match what we asked for.
    // A mismatch is a real-money anomaly: do not fulfil, leave it for review.
    const expected = Number(purchase.amount_minor);
    if (input.paidAmountMinor !== null && input.paidAmountMinor !== expected) {
      await tx.query(
        `UPDATE gift_purchases SET status = 'failed', updated_at = now() WHERE id = $1`,
        [purchase.id],
      );
      await tx.query(
        `INSERT INTO money_audit (actor_id, action, entity_type, entity_id, amount_minor, currency, metadata)
         VALUES (NULL, 'gift.amount_mismatch', 'gift_purchase', $1, $2, $3, $4)`,
        [purchase.id, input.paidAmountMinor, purchase.currency, JSON.stringify({ expected })],
      );
      return { applied: false, reason: "amount_mismatch", purchaseId: purchase.id };
    }

    const journalId = await postGiftPurchase(tx, {
      reference: input.reference,
      recipientId: purchase.recipient_id,
      amountMinor: expected,
      feeMinor: Number(purchase.fee_minor),
      currency: purchase.currency,
    });

    await tx.query(
      `UPDATE gift_purchases
          SET status = 'paid', provider_ref = COALESCE($2, provider_ref), journal_id = $3,
              paid_at = now(), updated_at = now()
        WHERE id = $1`,
      [purchase.id, input.providerRef, journalId],
    );

    // The unique index on purchase_id is what makes a duplicate impossible.
    await tx.query(
      `INSERT INTO paid_gifts (id, purchase_id, post_id, sender_id, recipient_id, gift_id, quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (purchase_id) DO NOTHING`,
      [newId(), purchase.id, purchase.post_id, purchase.buyer_id, purchase.recipient_id, purchase.gift_id, purchase.quantity],
    );

    await tx.query(
      `INSERT INTO money_audit (actor_id, action, entity_type, entity_id, amount_minor, currency, metadata)
       VALUES (NULL, 'gift.paid', 'gift_purchase', $1, $2, $3, $4)`,
      [purchase.id, expected, purchase.currency, JSON.stringify({ journalId })],
    );

    return { applied: true, purchaseId: purchase.id };
  });
}

/** Reverse a paid gift after a refund or chargeback. */
export async function refundGiftPurchase(
  pool: pg.Pool,
  input: { reference: string },
): Promise<GiftSettlementResult> {
  return withTransaction(pool, async (tx) => {
    const purchase = await queryOne<{
      id: string; recipient_id: string; amount_minor: string; fee_minor: string; currency: string; status: string;
    }>(
      tx as unknown as pg.Pool,
      `SELECT id, recipient_id, amount_minor, fee_minor, currency, status
         FROM gift_purchases WHERE reference = $1 FOR UPDATE`,
      [input.reference],
    );
    if (!purchase) return { applied: false, reason: "unknown_reference" };
    if (purchase.status !== "paid") return { applied: false, reason: `status_${purchase.status}`, purchaseId: purchase.id };

    await postGiftRefund(tx, {
      reference: input.reference,
      recipientId: purchase.recipient_id,
      amountMinor: Number(purchase.amount_minor),
      feeMinor: Number(purchase.fee_minor),
      currency: purchase.currency,
    });
    await tx.query(
      `UPDATE gift_purchases SET status = 'refunded', updated_at = now() WHERE id = $1`,
      [purchase.id],
    );
    await tx.query(
      `DELETE FROM paid_gifts WHERE purchase_id = $1`,
      [purchase.id],
    );
    return { applied: true, purchaseId: purchase.id };
  });
}

/** Mark a purchase failed. No money moved, so no journal. */
export async function failGiftPurchase(pool: pg.Pool, reference: string): Promise<GiftSettlementResult> {
  const purchase = await queryOne<{ id: string; status: string }>(
    pool,
    "SELECT id, status FROM gift_purchases WHERE reference = $1",
    [reference],
  );
  if (!purchase) return { applied: false, reason: "unknown_reference" };
  if (purchase.status !== "pending") return { applied: false, reason: `status_${purchase.status}` };
  await pool.query(`UPDATE gift_purchases SET status = 'failed', updated_at = now() WHERE id = $1`, [purchase.id]);
  return { applied: true, purchaseId: purchase.id };
}

/**
 * Apply a payout result. A payout is only recorded as paid when the provider
 * says so, and the ledger entry is written at that moment — never at request.
 */
export async function settlePayout(
  pool: pg.Pool,
  input: { reference: string; status: "paid" | "failed"; feeMinor: number | null; failureReason: string | null },
): Promise<{ applied: boolean; reason?: string }> {
  return withTransaction(pool, async (tx) => {
    const payout = await queryOne<{
      id: string; user_id: string; amount_minor: string; currency: string; status: string; journal_id: string | null;
    }>(
      tx as unknown as pg.Pool,
      `SELECT id, user_id, amount_minor, currency, status, journal_id FROM payouts WHERE reference = $1 FOR UPDATE`,
      [input.reference],
    );
    if (!payout) return { applied: false, reason: "unknown_reference" };
    if (payout.status === "paid") return { applied: false, reason: "already_paid" };
    const amountMinor = Number(payout.amount_minor);

    if (input.status === "paid") {
      const journalId = await postPayout(tx, {
        reference: input.reference,
        userId: payout.user_id,
        amountMinor,
        feeMinor: input.feeMinor ?? 0,
        currency: payout.currency,
      });
      await tx.query(
        `UPDATE payouts SET status = 'paid', journal_id = $2, provider_fee_minor = $3,
                completed_at = now(), updated_at = now() WHERE id = $1`,
        [payout.id, journalId, input.feeMinor ?? null],
      );
    } else {
      // Failed: release the reservation. The earnings were never debited (the
      // debit only happens on success), so there is nothing to reverse — only
      // the payout row moves out of the in-flight set.
      await tx.query(
        `UPDATE payouts SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
        [payout.id, input.failureReason ?? "Provider reported failure"],
      );
    }
    await tx.query(
      `INSERT INTO money_audit (actor_id, action, entity_type, entity_id, amount_minor, currency, metadata)
       VALUES (NULL, $1, 'payout', $2, $3, $4, $5)`,
      [`payout.${input.status}`, payout.id, amountMinor, payout.currency, JSON.stringify({ fee: input.feeMinor })],
    );
    return { applied: true };
  });
}

/**
 * Reverse a payout the provider clawed back after reporting success. Restores
 * the creator's earnings; never edits the original journal.
 */
export async function reversePayout(
  pool: pg.Pool,
  input: { reference: string; feeMinor: number | null },
): Promise<{ applied: boolean; reason?: string }> {
  return withTransaction(pool, async (tx) => {
    const payout = await queryOne<{
      id: string; user_id: string; amount_minor: string; currency: string; status: string;
    }>(
      tx as unknown as pg.Pool,
      `SELECT id, user_id, amount_minor, currency, status FROM payouts WHERE reference = $1 FOR UPDATE`,
      [input.reference],
    );
    if (!payout) return { applied: false, reason: "unknown_reference" };
    if (payout.status !== "paid") return { applied: false, reason: `status_${payout.status}` };
    await postPayoutReversal(tx, {
      reference: input.reference,
      userId: payout.user_id,
      amountMinor: Number(payout.amount_minor),
      feeMinor: input.feeMinor ?? 0,
      currency: payout.currency,
    });
    await tx.query(`UPDATE payouts SET status = 'reversed', updated_at = now() WHERE id = $1`, [payout.id]);
    return { applied: true };
  });
}
