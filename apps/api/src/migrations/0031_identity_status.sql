-- Identity and status: an avatar, an outfit, and a standing in the crowd.
--
-- The lever IMVU and Zepeto pull is "reconstruction of social status": people
-- spend to look like they belong to a rank. So status here is two things at
-- once - a title you earn by showing up (King, Queen, First Family, Class,
-- Warrior) and a look you buy with Vibe Yens (a frame and an outfit). The title
-- is derived, never stored as a claim, so no one can assert a rank they have not
-- reached. The look is an entitlement row bought through the ledger, so it can
-- never be conjured without paying.
--
-- Nothing here is a stored balance: a purchase is a journal entry like any
-- other, and `cosmetic_purchases` is only the record of what a user owns.

-- The catalogue itself lives in code (`COSMETICS` in modules/identity-status.ts),
-- the way the gift catalogue does, so a cosmetic is never a row that can drift
-- from its price. These tables only record what a user owns and wears.

-- What a user owns. A cosmetic is bought once; the primary key makes a repeat
-- purchase a no-op rather than a double charge.
CREATE TABLE cosmetic_purchases (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cosmetic_id text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, cosmetic_id)
);

-- What a user is wearing. At most one frame and one outfit each, enforced by the
-- primary key on (user_id, kind) rather than by application logic.
CREATE TABLE cosmetic_worn (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('frame', 'outfit')),
  cosmetic_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- Purchases are wallet movements, so the journal kind has to allow them.
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment',
    'wallet_topup', 'wallet_transfer', 'wallet_spend',
    'order_purchase', 'order_refund',
    'game_stake', 'game_payout', 'game_refund',
    'cosmetic_purchase'
  ));
