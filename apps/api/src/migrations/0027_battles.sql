-- Brand Battles: a time-bounded contest between two sides.
--
-- A battle is entertainment, not a betting market. Money is strictly optional
-- and secondary: a battle works with stake 0, and only a battle that was
-- created with a stake takes one. When there is a stake, it is Vibe Yens moved
-- into the existing `game_pot` escrow exactly like a staked game, so a battle
-- can never create or destroy Yens.
--
-- The platform does not take a rake on a battle. A rake on a coin-flip outcome
-- is the difference between a feature and a gambling product, and Part D is
-- explicit that users should not need to risk money to have a voice. The pot is
-- therefore returned to the winning side in full.
--
-- Votes are the score. A vote is one per user per battle, enforced by a unique
-- key rather than by a counter, so a retried request cannot inflate a score.

CREATE TABLE battles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  title text NOT NULL,
  topic text,
  side_a text NOT NULL,
  side_b text NOT NULL,
  -- 'open' accepts votes and stakes; 'closed' is a final result; 'cancelled'
  -- refunds every stake.
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  stake_minor bigint NOT NULL DEFAULT 0 CHECK (stake_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  pot_minor bigint NOT NULL DEFAULT 0 CHECK (pot_minor >= 0),
  winner text CHECK (winner IN ('a', 'b', 'tie')),
  ends_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX battles_status_idx ON battles (status, created_at DESC);
CREATE INDEX battles_host_idx ON battles (host_id, created_at DESC);

-- A participant picks a side and, if the battle is staked, backs it. `stake_minor`
-- is that user's contribution; `payout_minor` is what they received back.
CREATE TABLE battle_participants (
  battle_id uuid NOT NULL REFERENCES battles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('a', 'b')),
  stake_minor bigint NOT NULL DEFAULT 0 CHECK (stake_minor >= 0),
  payout_minor bigint NOT NULL DEFAULT 0 CHECK (payout_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, user_id)
);
CREATE INDEX battle_participants_side_idx ON battle_participants (battle_id, side);

-- One vote per user per battle, which is what makes the score trustworthy.
CREATE TABLE battle_votes (
  battle_id uuid NOT NULL REFERENCES battles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('a', 'b')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, user_id)
);
