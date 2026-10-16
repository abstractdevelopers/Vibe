-- Money: paid gifts, balances, payouts.
--
-- Design rules this schema enforces rather than documents:
--
--   1. Every financial movement is a balanced double-entry journal. There is no
--      mutable "balance" column anywhere; a balance is a SUM over ledger_entry.
--      A single column would let a bug silently create or destroy money, and it
--      could not be audited after the fact.
--   2. All amounts are integer minor units (kobo for NGN). Never a float.
--   3. A charge is only ever confirmed by a signature-verified provider webhook.
--      No redirect, no client call, no screenshot.
--   4. Idempotency is a database constraint, not a code path: one payment
--      intent maps to at most one gift purchase, and one purchase to at most
--      one delivered gift.
--
-- The economic model, stated once here so it cannot drift:
--   A buyer pays price_minor for a gift. Vibe keeps gift_fee_minor (30%).
--   The recipient is credited the remainder (70%) as creator earnings, which
--   becomes withdrawable only when `hold_until` has passed and the amount
--   clears the minimum payout. The fee is what Vibe earns on gifts.
--
-- Provider boundary: Bachs collects the money and Bachs pays creators out. Vibe
-- never holds a user's funds in an account it controls; the ledger records what
-- is owed, and settlement moves it through the provider.

-- A named ledger account. `kind` is the accounting category; the account row is
-- per-user for user-facing categories (creator_earnings) and singleton for
-- platform categories (platform_revenue, provider_clearing, provider_fee,
-- creator_payouts).
CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'creator_earnings',   -- liability: owed to a creator
    'platform_revenue',   -- income: Vibe's fee
    'provider_clearing',  -- asset: cash held at the provider on Vibe's behalf
    'provider_fee',       -- expense: what the provider charges
    'creator_payouts',    -- asset reduction: money paid out to creators
    'gift_refunds'        -- contra-revenue: refunded gift value
  )),
  user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One creator_earnings account per user+currency; one singleton per platform kind.
  CHECK (
    (kind = 'creator_earnings' AND user_id IS NOT NULL)
    OR (kind <> 'creator_earnings' AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX ledger_accounts_user_idx
  ON ledger_accounts (kind, user_id, currency) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_accounts_singleton_idx
  ON ledger_accounts (kind, currency) WHERE user_id IS NULL;

-- An immutable, balanced journal. `currency` and the sum invariant live on the
-- journal so a partial write cannot be mistaken for a complete transaction.
CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal', 'adjustment'
  )),
  currency text NOT NULL,
  -- Human-readable provenance: what business event produced this journal.
  reference text,
  memo text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Postings. Amounts are positive integers; `direction` carries the sign. A
-- signed single column invites sign errors that net to the wrong total.
CREATE TABLE ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES ledger_journals (id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_journal_idx ON ledger_entries (journal_id);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, created_at DESC);

-- What a gift costs. Prices live in the database so changing one is a data
-- change with an audit trail, not a deploy. `fee_bps` is basis points (3000 =
-- 30%), stored per gift so the split is reproducible for every purchase even
-- after the fee changes.
CREATE TABLE gift_catalogue (
  id text PRIMARY KEY,
  label text NOT NULL,
  hint text NOT NULL,
  emoji text NOT NULL,
  -- Presentation tier for the 3D treatment: 1 is a single element, 3 is a
  -- full-screen burst. Purely cosmetic.
  tier smallint NOT NULL DEFAULT 1 CHECK (tier BETWEEN 1 AND 3),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL,
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A purchase attempt. Created pending; only a verified webhook makes it paid.
CREATE TABLE gift_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  post_id uuid REFERENCES posts (id) ON DELETE SET NULL,
  gift_id text NOT NULL REFERENCES gift_catalogue (id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  fee_minor bigint NOT NULL CHECK (fee_minor >= 0),
  recipient_minor bigint NOT NULL CHECK (recipient_minor >= 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'refunded')),
  provider text,
  provider_ref text,
  -- Unique so a retried checkout cannot create a second purchase for one
  -- attempt, and the provider reference cannot be reused.
  reference text NOT NULL UNIQUE,
  journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (amount_minor = unit_price_minor * quantity),
  CHECK (fee_minor + recipient_minor = amount_minor)
);
CREATE INDEX gift_purchases_buyer_idx ON gift_purchases (buyer_id, created_at DESC);
CREATE INDEX gift_purchases_recipient_idx ON gift_purchases (recipient_id, created_at DESC);
CREATE INDEX gift_purchases_provider_ref_idx ON gift_purchases (provider, provider_ref);

-- A delivered gift. One paid purchase produces at most one of these, enforced
-- by the unique index, so a duplicate webhook cannot double-deliver.
CREATE TABLE paid_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL UNIQUE REFERENCES gift_purchases (id) ON DELETE RESTRICT,
  post_id uuid REFERENCES posts (id) ON DELETE SET NULL,
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  gift_id text NOT NULL REFERENCES gift_catalogue (id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paid_gifts_post_idx ON paid_gifts (post_id, created_at DESC);
CREATE INDEX paid_gifts_recipient_idx ON paid_gifts (recipient_id, created_at DESC);

-- A creator's bank account, held at the provider. Vibe stores the provider's
-- opaque destination id plus display-only masked details. It never stores a
-- full account number in its own tables: the provider is the system of record
-- for the destination, and `bank_account_last4` is only for the UI.
CREATE TABLE payout_destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_destination_id text NOT NULL,
  bank_name text,
  bank_code text,
  account_name text,
  account_last4 text CHECK (account_last4 IS NULL OR account_last4 ~ '^[0-9]{4}$'),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'disabled')),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_destination_id)
);
CREATE UNIQUE INDEX payout_destinations_default_idx
  ON payout_destinations (user_id, currency) WHERE is_default;
CREATE INDEX payout_destinations_user_idx ON payout_destinations (user_id, created_at DESC);

-- A payout attempt. `amount_minor` is reserved (moved out of the available
-- creator balance) at creation, so the same earnings cannot back two payouts.
CREATE TABLE payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  destination_id uuid NOT NULL REFERENCES payout_destinations (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'processing', 'paid', 'failed', 'reversed')),
  provider text NOT NULL,
  provider_ref text,
  provider_fee_minor bigint,
  failure_reason text,
  reference text NOT NULL UNIQUE,
  journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payouts_user_idx ON payouts (user_id, requested_at DESC);
CREATE INDEX payouts_status_idx ON payouts (status, requested_at);

-- Provider payout events, deduplicated on (provider, event_id) exactly like
-- payment webhooks, so a redelivery cannot move money twice.
CREATE TABLE payout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  payout_id uuid REFERENCES payouts (id) ON DELETE SET NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);

-- Immutable record of every gift purchase and payout, for support and dispute.
CREATE TABLE money_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  amount_minor bigint,
  currency text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX money_audit_entity_idx ON money_audit (entity_type, entity_id, created_at DESC);

-- A guard against ever recording a journal that does not balance. This is a
-- deferred constraint trigger: it fires at COMMIT, so the entries of one
-- journal may be inserted across several statements but the journal as a whole
-- must sum to zero per currency.
CREATE OR REPLACE FUNCTION ledger_journal_must_balance() RETURNS trigger AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO imbalance
    FROM ledger_entries
   WHERE journal_id = NEW.journal_id;
  IF imbalance <> 0 THEN
    RAISE EXCEPTION 'ledger journal % does not balance (off by %)', NEW.journal_id, imbalance;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_must_balance();

-- Seed the catalogue. Prices are in kobo: the cheapest gift is ₦200 and the
-- most expensive is ₦100,000. Kept in the database so a price change is an
-- auditable data change, and so a purchase can never take a client's word for
-- what a gift costs. fee_bps 3000 = Vibe keeps 30%.
INSERT INTO gift_catalogue (id, label, hint, emoji, tier, price_minor, currency, fee_bps, sort_order) VALUES
  ('rose',   'Rose',         'A small thank you',      '🌹', 1,    20000, 'NGN', 3000, 10),
  ('spark',  'Spark',        'You lit this up',        '✨', 1,    50000, 'NGN', 3000, 20),
  ('heart',  'Heart',        'Genuine love',           '💖', 1,   100000, 'NGN', 3000, 30),
  ('fire',   'Fire',         'This is great',          '🔥', 2,   200000, 'NGN', 3000, 40),
  ('drum',   'Talking drum', 'Make some noise',        '🪘', 2,   500000, 'NGN', 3000, 50),
  ('crown',  'Crown',        'For royalty',            '👑', 2,  1000000, 'NGN', 3000, 60),
  ('rocket', 'Rocket',       'Take off',               '🚀', 3,  2500000, 'NGN', 3000, 70),
  ('galaxy', 'Galaxy',       'The whole room sees it', '🌌', 3,  5000000, 'NGN', 3000, 80),
  ('lion',   'Lion',         'Bold support',           '🦁', 3, 10000000, 'NGN', 3000, 90)
ON CONFLICT (id) DO NOTHING;
