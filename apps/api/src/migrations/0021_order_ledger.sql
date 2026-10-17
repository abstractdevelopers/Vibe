-- Marketplace orders reach the ledger.
--
-- Until now a paid order flipped to `paid` and stopped there: no revenue, no
-- merchant earnings, nothing to reconcile. This adds the two journal kinds an
-- order produces and links the order to its journal so a refund can be posted
-- as an exact mirror and a redelivered webhook can never double-book.

ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment',
    'wallet_topup', 'wallet_transfer', 'wallet_spend',
    'order_purchase', 'order_refund'
  ));

-- The journal a paid order produced, so a refund mirrors the original.
ALTER TABLE orders ADD COLUMN journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT;
-- The fee actually charged, stored so a refund reverses exactly what was taken
-- even if the platform rate changes later.
ALTER TABLE orders ADD COLUMN fee_bps integer;
