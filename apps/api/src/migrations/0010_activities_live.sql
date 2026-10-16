-- 0010_activities_live.sql
--
-- Immersive Activities & Launch Engagement addendum.
--
-- Adds: live/scheduled activity rooms (sports, movie, music), shareable
-- activity links, official + automated host identity, opt-in reminders, coarse
-- device geography, and the launch-seeding support that lets official hosts run
-- real programming while staying honestly labelled.

-- ---------------------------------------------------------------------------
-- Honest host identity.
--
-- Every account is either a real person or an official/automated host, and the
-- platform says which. There is deliberately no "undisclosed" value: the whole
-- point of the column is that the answer is always available.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN host_kind text NOT NULL DEFAULT 'person'
  CHECK (host_kind IN ('person', 'official', 'automated'));
ALTER TABLE users ADD COLUMN host_disclosure text;

-- ---------------------------------------------------------------------------
-- Coarse device geography for Explore.
--
-- We never store a precise point. The client sends a position it already
-- rounded, or we round it server-side to ~1.1 km (2 decimal places) before it
-- is written. Discovery granularity stays city/area; the band only powers
-- distance ordering and is never returned to another member.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN lat_band double precision;
ALTER TABLE users ADD COLUMN lng_band double precision;
ALTER TABLE users ADD COLUMN located_at timestamptz;
ALTER TABLE places ADD COLUMN lat double precision;
ALTER TABLE places ADD COLUMN lng double precision;

-- ---------------------------------------------------------------------------
-- Activity rooms.
--
-- `state` only ever stores a terminal override ('ended', 'cancelled'). Whether a
-- room is live / starting soon / scheduled is DERIVED from the clock at read
-- time (see effectiveRoomState in modules/activities.ts), so the platform can
-- never claim a room is live when it is not.
-- ---------------------------------------------------------------------------
CREATE TABLE activity_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('sports', 'movie', 'music', 'other')),
  title text NOT NULL,
  topic text,
  state_override text CHECK (state_override IN ('ended', 'cancelled')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  city text,
  area text,
  visibility text NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public', 'private')),
  host_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  -- Where facts come from. We only ever cite an authorized source; we never
  -- invent a score or present a summary as eyewitness reporting.
  data_source text,
  data_source_url text,
  -- A link to a licensed viewing/listening service. Vibe coordinates; it does
  -- not retransmit. `playback_mode` says which, honestly.
  external_url text,
  playback_mode text NOT NULL DEFAULT 'coordinated'
    CHECK (playback_mode IN ('coordinated', 'synchronized')),
  spoiler_policy text NOT NULL DEFAULT 'open'
    CHECK (spoiler_policy IN ('open', 'spoiler_safe')),
  rules text,
  slow_mode_seconds int NOT NULL DEFAULT 0 CHECK (slow_mode_seconds >= 0),
  is_sponsored boolean NOT NULL DEFAULT false,
  sponsor_label text,
  recurrence text CHECK (recurrence IN ('weekly', 'fortnightly', 'monthly')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_rooms_live_idx ON activity_rooms (starts_at, ends_at);
CREATE INDEX activity_rooms_kind_idx ON activity_rooms (kind, starts_at);

-- Membership. A private room is only visible to members and the host.
CREATE TABLE room_members (
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'host', 'moderator')),
  muted boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- Room conversation. `kind` distinguishes ordinary chat from the scheduled
-- prompts, recaps and nominations an official host posts.
CREATE TABLE room_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'prompt', 'recap', 'nomination', 'system')),
  body text NOT NULL,
  spoiler boolean NOT NULL DEFAULT false,
  -- Set when an official/automated host posted it, so the client can label it
  -- without a second lookup.
  automated boolean NOT NULL DEFAULT false,
  removed_at timestamptz,
  removed_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_posts_room_idx ON room_posts (room_id, created_at DESC);

-- Polls (match score calls, player-of-the-match votes, film picks, best verse).
-- A vote is never framed as a wager and never carries a stake.
CREATE TABLE room_polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  question text NOT NULL,
  options jsonb NOT NULL,
  closes_at timestamptz,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE room_poll_votes (
  poll_id uuid NOT NULL REFERENCES room_polls (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  option_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);

-- Opt-in reminders for a team, artist, genre, Circle or scheduled activity.
CREATE TABLE activity_reminders (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  lead_minutes int NOT NULL DEFAULT 15 CHECK (lead_minutes BETWEEN 0 AND 1440),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id)
);

-- Shareable, context-preserving activity links. A private-room link is
-- revocable and a host controls who may join.
CREATE TABLE activity_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  revoked_at timestamptz,
  max_uses int,
  uses int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_links_room_idx ON activity_links (room_id);

-- Host moderation actions on a room, kept for the audit trail.
CREATE TABLE room_moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES activity_rooms (id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('remove_post', 'slow_mode', 'close_room', 'reopen_room')),
  target_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Analytics additions. New names are appended to the allow-list in
-- modules/analytics.ts; these are the viral-loop and repeat-engagement metrics
-- the addendum asks for.
-- ---------------------------------------------------------------------------
CREATE TABLE activity_link_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id uuid NOT NULL REFERENCES activity_links (id) ON DELETE CASCADE,
  -- Pseudonymous: a visitor id when we have one, otherwise null for anonymous
  -- previews. Never an IP address.
  visitor_id uuid,
  converted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
