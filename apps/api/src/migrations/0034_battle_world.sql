-- Battles as a place you visit, not a bar you read.
--
-- A battle now happens in a named stadium and has a fixed round length, and the
-- crowd can throw a paid punch ("boost") that costs Vibe Yens and is worth real
-- points. That is deliberately the only paid way to move a score, it is capped
-- per user per battle, and it is booked on the ledger exactly like a cosmetic:
-- the wallet liability falls and platform revenue rises. A boost can never
-- create or destroy Yens.
--
-- The stadium is presentation only: it decides how the arena is drawn, never
-- what the battle is worth. A deterministic mapping from battle id means a
-- battle keeps its stadium across reloads without a second source of truth.

ALTER TABLE battles ADD COLUMN stadium text NOT NULL DEFAULT 'colosseum'
  CHECK (stadium IN ('colosseum', 'dunes', 'lagoon', 'neon', 'rooftop', 'quarry'));

-- Every battle has a round. The default is ten minutes; the host may pick
-- anything from one minute to a day. `ends_at` remains the stored deadline so
-- an existing battle keeps working; it is derived from this on create.
ALTER TABLE battles ADD COLUMN interval_seconds integer NOT NULL DEFAULT 600
  CHECK (interval_seconds BETWEEN 60 AND 86400);

CREATE INDEX battles_stadium_idx ON battles (stadium, status);

-- A paid punch. Unlike `battle_gifts` (free, one of each kind per user), a
-- boost is repeatable but carries a price and a hard per-user cap, so a wallet
-- cannot simply buy a winner.
CREATE TABLE battle_boosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id uuid NOT NULL REFERENCES battles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('a', 'b')),
  kind text NOT NULL,
  points integer NOT NULL CHECK (points > 0),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'NGN',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX battle_boosts_battle_idx ON battle_boosts (battle_id, side);
CREATE INDEX battle_boosts_user_idx ON battle_boosts (battle_id, user_id);

-- Boosts are wallet movements, so the journal kind has to allow them.
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment',
    'wallet_topup', 'wallet_transfer', 'wallet_spend',
    'order_purchase', 'order_refund',
    'game_stake', 'game_payout', 'game_refund',
    'cosmetic_purchase', 'battle_boost'
  ));
