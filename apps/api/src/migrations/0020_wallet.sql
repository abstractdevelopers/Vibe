-- Vibe Yens: an optional stored balance, and send-to-a-friend.
--
-- This is a deliberate departure from the V1 rule that Vibe never holds a
-- balance. It is therefore OFF unless the operator sets WALLET_ENABLED=true,
-- because a stored balance and a peer-to-peer transfer are stored value and
-- money transmission — regulated activities that need a licence and compliance
-- review before they are switched on in production.
--
-- The money model is unchanged in spirit: every movement is still a balanced
-- double-entry journal, and a balance is still a SUM over the entries, never a
-- mutable column. A top-up is cash in at the provider against a liability owed
-- to the user; a transfer moves that liability between two users; spending it on
-- a gift moves the liability to the creator and the platform fee to revenue.

-- 'user_wallet' is a per-user liability, like creator_earnings.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN (
    'creator_earnings', 'platform_revenue', 'provider_clearing', 'provider_fee',
    'creator_payouts', 'gift_refunds', 'user_wallet'
  ));
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_check
  CHECK (
    (kind IN ('creator_earnings', 'user_wallet') AND user_id IS NOT NULL)
    OR (kind NOT IN ('creator_earnings', 'user_wallet') AND user_id IS NULL)
  );

-- Wallet movements are their own journal kinds.
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment',
    'wallet_topup', 'wallet_transfer', 'wallet_spend'
  ));

-- A top-up: a provider checkout that credits the wallet once its webhook is
-- verified. Created pending; only the webhook credits the balance.
CREATE TABLE wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  reference text NOT NULL UNIQUE,
  provider text,
  provider_ref text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'cancelled')),
  journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_topups_user_idx ON wallet_topups (user_id, created_at DESC);

-- A transfer from one user's wallet to another's. The unique reference makes a
-- retried send idempotent.
CREATE TABLE wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  note text,
  reference text NOT NULL UNIQUE,
  journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX wallet_transfers_sender_idx ON wallet_transfers (sender_id, created_at DESC);
CREATE INDEX wallet_transfers_recipient_idx ON wallet_transfers (recipient_id, created_at DESC);
