-- Battles as characters.
--
-- A battle used to be two labels and a bar, which read as a poll rather than a
-- fight. This gives each battle artwork and gives each side a face, and it adds
-- the two things a crowd does while a fight is running: it talks, and it throws
-- reactions. Comments and gifts are the "attack" moves, and they count toward
-- the score alongside votes — so a side can be carried by the crowd's noise, not
-- just its silent taps.
--
-- Votes stay free and one-per-user. Comments and gifts are additive and
-- idempotent per user where it matters, so no one can grind a side to the top
-- with a loop. Money is untouched: a gift here carries no value, exactly like a
-- post gift.

ALTER TABLE battles ADD COLUMN image_url text
  CHECK (image_url IS NULL OR image_url ~ '^https?://' OR image_url ~ '^/v1/media/[A-Za-z0-9._-]+$');
ALTER TABLE battles ADD COLUMN character_a_url text
  CHECK (character_a_url IS NULL OR character_a_url ~ '^https?://' OR character_a_url ~ '^/v1/media/[A-Za-z0-9._-]+$');
ALTER TABLE battles ADD COLUMN character_b_url text
  CHECK (character_b_url IS NULL OR character_b_url ~ '^https?://' OR character_b_url ~ '^/v1/media/[A-Za-z0-9._-]+$');

-- The comment feed. Each comment declares a side, because a comment is a move in
-- the fight: it is a point for the side it backs.
CREATE TABLE battle_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  battle_id uuid NOT NULL REFERENCES battles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('a', 'b')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 400),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX battle_comments_idx ON battle_comments (battle_id, created_at DESC);

-- Reactions thrown at a side. One of each kind per user per battle, so a
-- reaction is a gesture and not a grind.
CREATE TABLE battle_gifts (
  battle_id uuid NOT NULL REFERENCES battles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side text NOT NULL CHECK (side IN ('a', 'b')),
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (battle_id, user_id, kind)
);
CREATE INDEX battle_gifts_idx ON battle_gifts (battle_id, side);
