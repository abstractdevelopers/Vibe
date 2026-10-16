-- 0017_voice_rooms_and_ticketed_live.sql
--
-- Two additions to the Live surface.
--
-- 1. Voice rooms ("vibe rooms"): a host takes a stage, listeners join, and a
--    shared audio track plays for the room. This reuses activity_rooms and
--    room_members rather than inventing a parallel model: a voice room is just a
--    room whose kind is audio and whose members carry a stage role.
--
-- 2. Ticketed live: a host may charge for entry. The money path mirrors a paid
--    gift exactly — a provider checkout, then a ledger journal on the verified
--    webhook — because holding a balance here would be stored value, which V1
--    forbids. Entry is granted, never a wallet credit.

-- ---------------------------------------------------------------------------
-- Voice rooms and listen-together.
--
-- 'voice' is an open stage: anyone who joins can speak until muted.
-- 'listen' is music-forward: the host owns playback and the room listens.
-- ---------------------------------------------------------------------------
ALTER TABLE activity_rooms DROP CONSTRAINT activity_rooms_kind_check;
ALTER TABLE activity_rooms ADD CONSTRAINT activity_rooms_kind_check
  CHECK (kind IN ('sports', 'movie', 'music', 'other', 'voice', 'listen'));

-- Daily is a first-class cadence: a creator can run a show every day.
ALTER TABLE activity_rooms DROP CONSTRAINT activity_rooms_recurrence_check;
ALTER TABLE activity_rooms ADD CONSTRAINT activity_rooms_recurrence_check
  CHECK (recurrence IN ('daily', 'weekly', 'fortnightly', 'monthly'));

-- What the room is playing, and since when. A single track, not a playlist, so
-- a late joiner can be dropped into the same position as everyone else.
ALTER TABLE activity_rooms ADD COLUMN audio_track jsonb;
ALTER TABLE activity_rooms ADD COLUMN audio_started_at timestamptz;
-- A host can hand the room to a co-host and take it back.
ALTER TABLE activity_rooms ADD COLUMN cohost_id uuid REFERENCES users (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Ticketed entry.
--
-- A room with ticket_price_minor = 0 is free. Anything above zero requires a
-- paid ticket before join. The ticket is a grant, not a balance: it names the
-- purchase that paid for it and can never be spent, transferred or cashed out.
-- ---------------------------------------------------------------------------
ALTER TABLE activity_rooms ADD COLUMN ticket_price_minor bigint NOT NULL DEFAULT 0
  CHECK (ticket_price_minor >= 0);
ALTER TABLE activity_rooms ADD COLUMN banner_url text;

CREATE TABLE room_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Set for a paid ticket; null for a host/comp grant.
  purchase_id uuid REFERENCES gift_purchases (id) ON DELETE SET NULL,
  reference text,
  price_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'NGN',
  status text NOT NULL DEFAULT 'granted' CHECK (status IN ('pending', 'granted', 'refunded')),
  granted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One ticket per person per room.
  UNIQUE (room_id, user_id)
);
CREATE INDEX room_tickets_purchase_idx ON room_tickets (purchase_id) WHERE purchase_id IS NOT NULL;

-- A ticket is a purchase row (so it reuses the whole verified-webhook and
-- ledger path) that points at the room it buys into. `gift_id` stays NOT NULL
-- for compatibility, so a non-gift purchase needs a catalogue row to name it;
-- 'live_ticket' is that row and is never listed as a gift.
ALTER TABLE gift_purchases ADD COLUMN room_id uuid REFERENCES activity_rooms (id) ON DELETE SET NULL;
CREATE INDEX gift_purchases_room_idx ON gift_purchases (room_id) WHERE room_id IS NOT NULL;
INSERT INTO gift_catalogue (id, label, hint, emoji, tier, price_minor, currency, fee_bps, active)
VALUES ('live_ticket', 'Live ticket', 'Entry to a live room', '🎟️', 1, 0, 'NGN', 3000, false)
ON CONFLICT (id) DO NOTHING;

-- The 'ticket_purchase' / 'ticket_refund' journals.
ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment'
  ));

-- ---------------------------------------------------------------------------
-- Stage roles for a voice room. A listener can raise a hand; the host brings
-- them up. Everyone on the stage is a 'speaker'.
-- ---------------------------------------------------------------------------
ALTER TABLE room_members DROP CONSTRAINT room_members_role_check;
ALTER TABLE room_members ADD CONSTRAINT room_members_role_check
  CHECK (role IN ('member', 'host', 'moderator', 'speaker'));
ALTER TABLE room_members ADD COLUMN hand_raised boolean NOT NULL DEFAULT false;
-- A speaker muted by the host cannot unmute themselves.
ALTER TABLE room_members ADD COLUMN muted_by_host boolean NOT NULL DEFAULT false;
