-- Live experience: room gifts, hype, and paid gifts in a room.
--
-- The voice/listen room already has stage roles (room_members.role includes
-- 'speaker', with hand_raised and muted_by_host) and a synced audio track. What
-- was missing is everything that makes a room feel alive: gifts that land in the
-- room, an energy score, and a place for a paid gift to record the room it was
-- sent in.
--
-- Free room gifts live in their own table. A paid room gift reuses the whole
-- money pipeline: a gift_purchases row that now carries a room_id, confirmed by
-- the provider webhook and journalled to the ledger exactly like any other
-- paid gift. Vibe still never holds a balance here.

-- Free, non-monetary gifts sent inside a room (a cheer, a fire, a hug).
CREATE TABLE room_gifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);
CREATE INDEX room_gifts_room_idx ON room_gifts (room_id, created_at DESC);
CREATE INDEX room_gifts_recipient_idx ON room_gifts (recipient_id, created_at DESC);

-- A paid gift can be sent in a room as well as on a post. `gift_purchases`
-- already carries `room_id` (0017); `paid_gifts` gets one here so a delivered
-- gift records the room it landed in.
ALTER TABLE paid_gifts ADD COLUMN room_id uuid REFERENCES activity_rooms (id) ON DELETE SET NULL;
CREATE INDEX paid_gifts_room_idx ON paid_gifts (room_id, created_at DESC);

-- Energy. Reactions and gifts raise it; it decays by being recomputed from the
-- last hour of activity rather than stored as a mutable running total, so it
-- cannot drift. The column caches the last computed value for listing.
ALTER TABLE activity_rooms ADD COLUMN hype integer NOT NULL DEFAULT 0;
ALTER TABLE activity_rooms ADD COLUMN edited_at timestamptz;

-- Emoji reactions inside a room (the energy layer). Lightweight and ephemeral
-- in spirit: they feed the hype score and are broadcast, not persisted for long.
CREATE TABLE room_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_reactions_room_idx ON room_reactions (room_id, created_at DESC);
