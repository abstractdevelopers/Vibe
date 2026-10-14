-- Non-monetary social gifts.
--
-- The spec forbids a Vibe-held wallet, stored value, pooled funds and general
-- P2P transfer in V1. So a gift here is explicitly NOT money: it is a small,
-- non-purchasable social gesture (a "sparkle", a "high five") that a person
-- sends to the author of a post. There is no balance, no price, no top-up, no
-- cash-out, and nothing to redeem. The set of gift kinds is fixed in code and
-- validated server-side, so no gift can ever carry a value.

CREATE TABLE post_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX post_gifts_post_idx ON post_gifts (post_id, created_at DESC);
CREATE INDEX post_gifts_recipient_idx ON post_gifts (recipient_id, created_at DESC);
-- One of each kind per sender per post, so gifting is a gesture, not a grind.
CREATE UNIQUE INDEX post_gifts_unique_idx ON post_gifts (post_id, sender_id, kind);
