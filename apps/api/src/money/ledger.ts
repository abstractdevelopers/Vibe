import type pg from "pg";
import { queryOne } from "../db.js";

/**
 * Double-entry ledger.
 *
 * Every function here writes a journal whose entries sum to zero, in one
 * transaction, under the deferred constraint trigger in 0012_money.sql. There is
 * no mutable balance column: a balance is always a SUM over the entries, so a
 * bug cannot silently create or destroy money, and any discrepancy is
 * reconstructable from history.
 *
 * Signs, stated once:
 *   debit  increases assets and expenses, decreases liabilities and income.
 *   credit decreases assets and expenses, increases liabilities and income.
 *
 * A buyer paying for a gift is cash arriving at the provider (asset up, debit
 * provider_clearing), split into what Vibe keeps (income up, credit
 * platform_revenue) and what it owes the creator (liability up, credit
 * creator_earnings). Paying a creator is that liability falling (debit
 * creator_earnings) against cash leaving (credit creator_payouts).
 */

export type LedgerAccountKind =
  | "creator_earnings"
  | "platform_revenue"
  | "provider_clearing"
  | "provider_fee"
  | "creator_payouts"
  | "gift_refunds"
  | "user_wallet"
  | "game_pot";

export type JournalKind =
  | "gift_purchase"
  | "gift_refund"
  | "creator_payout"
  | "payout_reversal"
  | "ticket_purchase"
  | "ticket_refund"
  | "order_purchase"
  | "order_refund"
  | "adjustment"
  | "wallet_topup"
  | "wallet_transfer"
  | "wallet_spend"
  | "game_stake"
  | "game_payout"
  | "game_refund";

interface Entry {
  accountId: string;
  direction: "debit" | "credit";
  amountMinor: number;
}

/** How long newly earned money is held before it can be paid out. */
export const HOLD_DAYS = 7;
/** Below this, a payout is refused: the provider fee would eat it. */
export const MIN_PAYOUT_MINOR = 100_000; // ₦1,000

async function accountId(
  tx: pg.PoolClient,
  kind: LedgerAccountKind,
  currency: string,
  userId: string | null,
): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    tx as unknown as pg.Pool,
    `SELECT id FROM ledger_accounts
      WHERE kind = $1 AND currency = $2
        AND user_id IS NOT DISTINCT FROM $3::uuid`,
    [kind, currency, userId],
  );
  if (existing) return existing.id;
  const created = await queryOne<{ id: string }>(
    tx as unknown as pg.Pool,
    `INSERT INTO ledger_accounts (kind, user_id, currency) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING id`,
    [kind, userId, currency],
  );
  if (created) return created.id;
  // Lost a race with a concurrent insert; the row exists now.
  const again = await queryOne<{ id: string }>(
    tx as unknown as pg.Pool,
    `SELECT id FROM ledger_accounts
      WHERE kind = $1 AND currency = $2 AND user_id IS NOT DISTINCT FROM $3::uuid`,
    [kind, currency, userId],
  );
  if (!again) throw new Error(`Could not resolve ledger account ${kind}`);
  return again.id;
}

async function writeJournal(
  tx: pg.PoolClient,
  input: { kind: JournalKind; currency: string; reference: string; memo: string; entries: Entry[] },
): Promise<string> {
  const debits = input.entries.filter((e) => e.direction === "debit").reduce((s, e) => s + e.amountMinor, 0);
  const credits = input.entries.filter((e) => e.direction === "credit").reduce((s, e) => s + e.amountMinor, 0);
  // Fail here, in the application, with a useful message, rather than letting
  // the database trigger abort the transaction with less context.
  if (debits !== credits) {
    throw new Error(`Unbalanced journal ${input.kind}: debits ${debits} != credits ${credits}`);
  }
  const journal = await queryOne<{ id: string }>(
    tx as unknown as pg.Pool,
    `INSERT INTO ledger_journals (kind, currency, reference, memo) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.kind, input.currency, input.reference, input.memo],
  );
  const journalId = journal!.id;
  for (const entry of input.entries) {
    await tx.query(
      `INSERT INTO ledger_entries (journal_id, account_id, direction, amount_minor) VALUES ($1, $2, $3, $4)`,
      [journalId, entry.accountId, entry.direction, entry.amountMinor],
    );
  }
  return journalId;
}

/**
 * Record a paid gift purchase. Called only after a signature-verified webhook
 * has confirmed the charge.
 */
export async function postGiftPurchase(
  tx: pg.PoolClient,
  input: {
    reference: string;
    recipientId: string;
    amountMinor: number;
    feeMinor: number;
    currency: string;
  },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [
    { accountId: clearing, direction: "debit", amountMinor: input.amountMinor },
  ];
  // A 100%-fee gift would produce a zero-amount entry, which the schema
  // forbids; and a 0%-fee gift produces no revenue entry at all.
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "credit", amountMinor: input.feeMinor });
  const creatorMinor = input.amountMinor - input.feeMinor;
  if (creatorMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.recipientId);
    entries.push({ accountId: earnings, direction: "credit", amountMinor: creatorMinor });
  }
  return writeJournal(tx, {
    kind: "gift_purchase",
    currency: input.currency,
    reference: input.reference,
    memo: "Paid gift purchase",
    entries,
  });
}

/** Reverse a purchase after a refund or chargeback. Never edits the original. */
export async function postGiftRefund(
  tx: pg.PoolClient,
  input: { reference: string; recipientId: string; amountMinor: number; feeMinor: number; currency: string },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  // A refund is the exact mirror of the purchase: cash goes back out, and the
  // revenue and the creator's earnings are both given up. It deliberately does
  // NOT post to a separate "refunds" account — that would double-count the
  // reversal and leave the journal unbalanced.
  const entries: Entry[] = [
    { accountId: clearing, direction: "credit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "debit", amountMinor: input.feeMinor });
  const creatorMinor = input.amountMinor - input.feeMinor;
  if (creatorMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.recipientId);
    entries.push({ accountId: earnings, direction: "debit", amountMinor: creatorMinor });
  }
  return writeJournal(tx, {
    kind: "gift_refund",
    currency: input.currency,
    reference: input.reference,
    memo: "Gift refund",
    entries,
  });
}

/**
 * Record a completed creator payout. The creator's liability falls by the
 * amount; the provider fee is an expense of the platform, not of the creator.
 */
export async function postPayout(
  tx: pg.PoolClient,
  input: {
    reference: string;
    userId: string;
    amountMinor: number;
    feeMinor: number;
    currency: string;
  },
): Promise<string> {
  const earnings = await accountId(tx, "creator_earnings", input.currency, input.userId);
  const payouts = await accountId(tx, "creator_payouts", input.currency, null);
  const entries: Entry[] = [
    { accountId: earnings, direction: "debit", amountMinor: input.amountMinor },
    { accountId: payouts, direction: "credit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) {
    const fee = await accountId(tx, "provider_fee", input.currency, null);
    const clearing = await accountId(tx, "provider_clearing", input.currency, null);
    entries.push({ accountId: fee, direction: "debit", amountMinor: input.feeMinor });
    entries.push({ accountId: clearing, direction: "credit", amountMinor: input.feeMinor });
  }
  return writeJournal(tx, {
    kind: "creator_payout",
    currency: input.currency,
    reference: input.reference,
    memo: "Creator payout",
    entries,
  });
}

/** Put a failed payout's money back into the creator's available balance. */
export async function postPayoutReversal(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; feeMinor: number; currency: string },
): Promise<string> {
  const earnings = await accountId(tx, "creator_earnings", input.currency, input.userId);
  const payouts = await accountId(tx, "creator_payouts", input.currency, null);
  const entries: Entry[] = [
    { accountId: payouts, direction: "debit", amountMinor: input.amountMinor },
    { accountId: earnings, direction: "credit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) {
    const fee = await accountId(tx, "provider_fee", input.currency, null);
    const clearing = await accountId(tx, "provider_clearing", input.currency, null);
    entries.push({ accountId: fee, direction: "credit", amountMinor: input.feeMinor });
    entries.push({ accountId: clearing, direction: "debit", amountMinor: input.feeMinor });
  }
  return writeJournal(tx, {
    kind: "payout_reversal",
    currency: input.currency,
    reference: input.reference,
    memo: "Payout failed; earnings restored",
    entries,
  });
}

/**
 * A paid ticket to a live room. Structurally identical to a gift purchase:
 * cash comes in, the platform keeps its cut, the host earns the rest. The
 * difference is only what it buys — entry, not a gift.
 */
export async function postTicketPurchase(
  tx: pg.PoolClient,
  input: {
    reference: string;
    hostId: string;
    amountMinor: number;
    feeMinor: number;
    currency: string;
  },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [
    { accountId: clearing, direction: "debit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "credit", amountMinor: input.feeMinor });
  const hostMinor = input.amountMinor - input.feeMinor;
  if (hostMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.hostId);
    entries.push({ accountId: earnings, direction: "credit", amountMinor: hostMinor });
  }
  return writeJournal(tx, {
    kind: "ticket_purchase",
    currency: input.currency,
    reference: input.reference,
    memo: "Live room ticket",
    entries,
  });
}

/** The exact mirror of a ticket purchase, for a refunded entry. */
export async function postTicketRefund(
  tx: pg.PoolClient,
  input: { reference: string; hostId: string; amountMinor: number; feeMinor: number; currency: string },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [
    { accountId: clearing, direction: "credit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "debit", amountMinor: input.feeMinor });
  const hostMinor = input.amountMinor - input.feeMinor;
  if (hostMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.hostId);
    entries.push({ accountId: earnings, direction: "debit", amountMinor: hostMinor });
  }
  return writeJournal(tx, {
    kind: "ticket_refund",
    currency: input.currency,
    reference: input.reference,
    memo: "Live room ticket refund",
    entries,
  });
}
/**
 * A paid marketplace order. Cash arrives at the provider (debit clearing), split
 * into what Vibe keeps (credit platform_revenue) and what it owes the merchant
 * (credit creator_earnings for the merchant's owner). Merchant earnings use the
 * same hold as a creator's, so a payout releases them the same way.
 */
export async function postOrderPurchase(
  tx: pg.PoolClient,
  input: {
    reference: string;
    merchantOwnerId: string;
    amountMinor: number;
    feeMinor: number;
    currency: string;
  },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [
    { accountId: clearing, direction: "debit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "credit", amountMinor: input.feeMinor });
  const merchantMinor = input.amountMinor - input.feeMinor;
  if (merchantMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.merchantOwnerId);
    entries.push({ accountId: earnings, direction: "credit", amountMinor: merchantMinor });
  }
  return writeJournal(tx, {
    kind: "order_purchase",
    currency: input.currency,
    reference: input.reference,
    memo: "Marketplace order",
    entries,
  });
}

/** The exact mirror of an order purchase, for a refunded order. */
export async function postOrderRefund(
  tx: pg.PoolClient,
  input: {
    reference: string;
    merchantOwnerId: string;
    amountMinor: number;
    feeMinor: number;
    currency: string;
  },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [
    { accountId: clearing, direction: "credit", amountMinor: input.amountMinor },
  ];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "debit", amountMinor: input.feeMinor });
  const merchantMinor = input.amountMinor - input.feeMinor;
  if (merchantMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.merchantOwnerId);
    entries.push({ accountId: earnings, direction: "debit", amountMinor: merchantMinor });
  }
  return writeJournal(tx, {
    kind: "order_refund",
    currency: input.currency,
    reference: input.reference,
    memo: "Marketplace order refund",
    entries,
  });
}



export interface Balance {
  currency: string;
  /** Total ever credited by paid gifts. */
  lifetimeEarnedMinor: number;
  /** Already paid out. */
  paidOutMinor: number;
  /** Earned inside the hold window; not yet withdrawable. */
  pendingMinor: number;
  /** Reserved by payouts that are requested or processing. */
  inFlightMinor: number;
  /** What the creator can withdraw right now. */
  availableMinor: number;
  /** The amount needed before a payout is allowed. */
  minPayoutMinor: number;
}

/**
 * A creator's balance, derived from the ledger. `in_flight` is subtracted so
 * the same earnings cannot back two simultaneous payout requests.
 */
export async function creatorBalance(pool: pg.Pool, userId: string, currency: string): Promise<Balance> {
  const earnings = await queryOne<{ id: string }>(
    pool,
    `SELECT id FROM ledger_accounts
      WHERE kind = 'creator_earnings' AND user_id = $1 AND currency = $2`,
    [userId, currency],
  );
  if (!earnings) {
    return {
      currency,
      lifetimeEarnedMinor: 0,
      paidOutMinor: 0,
      pendingMinor: 0,
      inFlightMinor: 0,
      availableMinor: 0,
      minPayoutMinor: MIN_PAYOUT_MINOR,
    };
  }
  const totals = await queryOne<{ credits: string; debits: string; pending: string }>(
    pool,
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS credits,
       COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS debits,
       COALESCE(SUM(CASE WHEN direction = 'credit' AND created_at > now() - ($2 || ' days')::interval
                         THEN amount_minor ELSE 0 END), 0) AS pending
     FROM ledger_entries WHERE account_id = $1`,
    [earnings.id, String(HOLD_DAYS)],
  );
  const inFlight = await queryOne<{ total: string }>(
    pool,
    `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM payouts
      WHERE user_id = $1 AND currency = $2 AND status IN ('requested', 'processing')`,
    [userId, currency],
  );
  const credits = Number(totals?.credits ?? 0);
  const debits = Number(totals?.debits ?? 0);
  const pending = Number(totals?.pending ?? 0);
  const reserved = Number(inFlight?.total ?? 0);
  return {
    currency,
    lifetimeEarnedMinor: credits,
    paidOutMinor: debits,
    pendingMinor: pending,
    inFlightMinor: reserved,
    availableMinor: Math.max(0, credits - debits - pending - reserved),
    minPayoutMinor: MIN_PAYOUT_MINOR,
  };
}

/**
 * Wallet (Vibe Yens) movements. These exist only when `WALLET_ENABLED` is on;
 * the routes that call them are not even registered otherwise.
 *
 * A top-up is cash arriving at the provider (asset up) against a liability Vibe
 * now owes the user (wallet up). A transfer moves that liability between two
 * users, so it nets to zero and never touches cash. Spending on a gift moves the
 * liability to the creator and the platform's cut to revenue.
 */

/** A verified top-up: cash in, wallet liability up. */
export async function postWalletTopup(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; currency: string },
): Promise<string> {
  const clearing = await accountId(tx, "provider_clearing", input.currency, null);
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  return writeJournal(tx, {
    kind: "wallet_topup",
    currency: input.currency,
    reference: input.reference,
    memo: "Vibe Yens top-up",
    entries: [
      { accountId: clearing, direction: "debit", amountMinor: input.amountMinor },
      { accountId: wallet, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/** Send to a friend: the liability moves from sender to recipient. */
export async function postWalletTransfer(
  tx: pg.PoolClient,
  input: { reference: string; senderId: string; recipientId: string; amountMinor: number; currency: string },
): Promise<string> {
  const from = await accountId(tx, "user_wallet", input.currency, input.senderId);
  const to = await accountId(tx, "user_wallet", input.currency, input.recipientId);
  return writeJournal(tx, {
    kind: "wallet_transfer",
    currency: input.currency,
    reference: input.reference,
    memo: "Vibe Yens transfer",
    entries: [
      { accountId: from, direction: "debit", amountMinor: input.amountMinor },
      { accountId: to, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/** Spend wallet balance on a gift: wallet liability falls, creator earns, Vibe takes its fee. */
export async function postWalletSpend(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; recipientId: string; amountMinor: number; feeMinor: number; currency: string },
): Promise<string> {
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const entries: Entry[] = [{ accountId: wallet, direction: "debit", amountMinor: input.amountMinor }];
  if (input.feeMinor > 0) entries.push({ accountId: revenue, direction: "credit", amountMinor: input.feeMinor });
  const creatorMinor = input.amountMinor - input.feeMinor;
  if (creatorMinor > 0) {
    const earnings = await accountId(tx, "creator_earnings", input.currency, input.recipientId);
    entries.push({ accountId: earnings, direction: "credit", amountMinor: creatorMinor });
  }
  return writeJournal(tx, {
    kind: "wallet_spend",
    currency: input.currency,
    reference: input.reference,
    memo: "Gift paid from Vibe Yens",
    entries,
  });
}

/** A user's wallet balance, derived from the ledger. */
export async function walletBalance(pool: pg.Pool, userId: string, currency: string): Promise<{ currency: string; balanceMinor: number }> {
  const account = await queryOne<{ id: string }>(
    pool,
    `SELECT id FROM ledger_accounts WHERE kind = 'user_wallet' AND user_id = $1 AND currency = $2`,
    [userId, currency],
  );
  if (!account) return { currency, balanceMinor: 0 };
  const totals = await queryOne<{ credits: string; debits: string }>(
    pool,
    `SELECT
       COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS credits,
       COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS debits
     FROM ledger_entries WHERE account_id = $1`,
    [account.id],
  );
  return { currency, balanceMinor: Math.max(0, Number(totals?.credits ?? 0) - Number(totals?.debits ?? 0)) };
}


/**
 * Games: staked Yens in a pot.
 *
 * A stake moves a player's wallet Yens into the session's escrow account; the
 * pot is therefore real, backed Yens, not a number the server made up. A payout
 * moves the pot to the winner and credits the platform's rake to revenue, so
 * the total is conserved: whatever left the wallets lands in a wallet or in
 * revenue, never nowhere. A cancelled game refunds stakes exactly.
 */

/** One player stakes: wallet down, pot up. */
export async function postGameStake(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; currency: string },
): Promise<string> {
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  const pot = await accountId(tx, "game_pot", input.currency, null);
  return writeJournal(tx, {
    kind: "game_stake",
    currency: input.currency,
    reference: input.reference,
    memo: "Game stake into the pot",
    entries: [
      { accountId: wallet, direction: "debit", amountMinor: input.amountMinor },
      { accountId: pot, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/** The pot pays the winner, and Vibe keeps its rake. */
export async function postGamePayout(
  tx: pg.PoolClient,
  input: { reference: string; winnerId: string; potMinor: number; rakeMinor: number; currency: string },
): Promise<string> {
  const pot = await accountId(tx, "game_pot", input.currency, null);
  const revenue = await accountId(tx, "platform_revenue", input.currency, null);
  const winner = await accountId(tx, "user_wallet", input.currency, input.winnerId);
  const entries: Entry[] = [{ accountId: pot, direction: "debit", amountMinor: input.potMinor }];
  if (input.rakeMinor > 0) entries.push({ accountId: revenue, direction: "credit", amountMinor: input.rakeMinor });
  const prizeMinor = input.potMinor - input.rakeMinor;
  if (prizeMinor > 0) entries.push({ accountId: winner, direction: "credit", amountMinor: prizeMinor });
  return writeJournal(tx, {
    kind: "game_payout",
    currency: input.currency,
    reference: input.reference,
    memo: "Game pot paid to the winner",
    entries,
  });
}

/** A cancelled game returns every stake: pot down, wallet up. */
export async function postGameRefund(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; currency: string },
): Promise<string> {
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  const pot = await accountId(tx, "game_pot", input.currency, null);
  return writeJournal(tx, {
    kind: "game_refund",
    currency: input.currency,
    reference: input.reference,
    memo: "Game stake refunded",
    entries: [
      { accountId: pot, direction: "debit", amountMinor: input.amountMinor },
      { accountId: wallet, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/*
 * Battles reuse the game pot and the game journal kinds. A battle takes no
 * rake: the whole pot goes to the winning side. That is deliberate — a rake on
 * a vote outcome would make this a gambling product, and Part D is explicit
 * that a user should not have to risk money to have a voice.
 */

/** A battle stake: wallet Yens into the pot, identical to a game stake. */
export async function postBattleStake(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; currency: string },
): Promise<string> {
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  const pot = await accountId(tx, "game_pot", input.currency, null);
  return writeJournal(tx, {
    kind: "game_stake",
    currency: input.currency,
    reference: input.reference,
    memo: "Battle stake into the pot",
    entries: [
      { accountId: wallet, direction: "debit", amountMinor: input.amountMinor },
      { accountId: pot, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}

/**
 * Pay the winning backers. The pot is split across the winners in proportion to
 * what each staked, and the platform keeps nothing.
 */
export async function postBattlePayout(
  tx: pg.PoolClient,
  input: {
    reference: string;
    currency: string;
    /** Each winner and the exact amount they get; must sum to the pot. */
    payouts: Array<{ userId: string; amountMinor: number }>;
  },
): Promise<string> {
  const pot = await accountId(tx, "game_pot", input.currency, null);
  const total = input.payouts.reduce((sum, p) => sum + p.amountMinor, 0);
  if (total <= 0) throw new Error("Battle payout with nothing to pay");
  const entries: Entry[] = [{ accountId: pot, direction: "debit", amountMinor: total }];
  for (const p of input.payouts) {
    if (p.amountMinor <= 0) continue;
    entries.push({
      accountId: await accountId(tx, "user_wallet", input.currency, p.userId),
      direction: "credit",
      amountMinor: p.amountMinor,
    });
  }
  return writeJournal(tx, {
    kind: "game_payout",
    currency: input.currency,
    reference: input.reference,
    memo: "Battle pot paid to the winning side",
    entries,
  });
}

/** A cancelled battle returns every stake in full. */
export async function postBattleRefund(
  tx: pg.PoolClient,
  input: { reference: string; userId: string; amountMinor: number; currency: string },
): Promise<string> {
  const wallet = await accountId(tx, "user_wallet", input.currency, input.userId);
  const pot = await accountId(tx, "game_pot", input.currency, null);
  return writeJournal(tx, {
    kind: "game_refund",
    currency: input.currency,
    reference: input.reference,
    memo: "Battle stake refunded",
    entries: [
      { accountId: pot, direction: "debit", amountMinor: input.amountMinor },
      { accountId: wallet, direction: "credit", amountMinor: input.amountMinor },
    ],
  });
}
