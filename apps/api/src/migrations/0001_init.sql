-- Vibe first-sprint schema.
-- Identifiers are UUIDs; timestamps are UTC (timestamptz). Money is stored as
-- integer minor units in BIGINT with an explicit ISO 4217 currency code.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  bio text,
  avatar_url text,
  interests text[] NOT NULL DEFAULT '{}',
  is_admin boolean NOT NULL DEFAULT false,
  discoverable boolean NOT NULL DEFAULT true,
  profile_audience text NOT NULL DEFAULT 'connections'
    CHECK (profile_audience IN ('public', 'connections', 'private')),
  activity_visibility text NOT NULL DEFAULT 'connections'
    CHECK (activity_visibility IN ('public', 'connections', 'private')),
  read_receipts boolean NOT NULL DEFAULT true,
  location_enabled boolean NOT NULL DEFAULT false,
  contacts_sync_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX users_handle_idx ON users (lower(handle));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE follows (
  follower_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE mutes (
  muter_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  muted_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (muter_id, muted_id)
);

CREATE TABLE circles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  privacy text NOT NULL DEFAULT 'private'
    CHECK (privacy IN ('private', 'invite_only', 'public_discoverable')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE circle_members (
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (circle_id, user_id)
);
CREATE INDEX circle_members_user_idx ON circle_members (user_id);

CREATE TABLE circle_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'text',
  audience text NOT NULL DEFAULT 'connections'
    CHECK (audience IN ('public', 'connections', 'circle', 'private')),
  body text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'pending_review', 'limited', 'removed', 'hidden')),
  is_sponsored boolean NOT NULL DEFAULT false,
  advertiser_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX posts_created_idx ON posts (created_at DESC, id DESC);
CREATE INDEX posts_circle_idx ON posts (circle_id, created_at DESC);
CREATE INDEX posts_author_idx ON posts (author_id, created_at DESC);

CREATE TABLE post_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  url text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at);

CREATE TABLE reactions (
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'like',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id, kind)
);

CREATE TABLE activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL UNIQUE REFERENCES posts (id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  type text NOT NULL DEFAULT 'poll' CHECK (type IN ('poll', 'debate', 'quiz', 'challenge')),
  state text NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'scheduled', 'open', 'closed', 'results_published', 'cancelled', 'under_review')),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE poll_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  label text NOT NULL,
  position integer NOT NULL DEFAULT 0
);
CREATE INDEX poll_options_activity_idx ON poll_options (activity_id, position);

-- Single-choice poll: one row per user per activity. The primary key enforces
-- the one-vote rule in the database, not just in application code.
CREATE TABLE votes (
  activity_id uuid NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES poll_options (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id)
);
CREATE INDEX votes_option_idx ON votes (option_id);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  organizer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  state text NOT NULL DEFAULT 'proposed'
    CHECK (state IN ('draft', 'proposed', 'confirming', 'confirmed', 'completed', 'cancelled')),
  starts_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  place text,
  online_url text,
  budget_amount bigint CHECK (budget_amount IS NULL OR budget_amount >= 0),
  budget_currency text,
  participant_limit integer CHECK (participant_limit IS NULL OR participant_limit > 0),
  cancellation_policy text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (budget_amount IS NULL OR budget_currency IS NOT NULL)
);
CREATE INDEX plans_circle_idx ON plans (circle_id, starts_at);

CREATE TABLE rsvps (
  plan_id uuid NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('interested', 'going', 'waitlisted', 'declined', 'checked_in')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id uuid NOT NULL REFERENCES circles (id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  payer_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  description text NOT NULL,
  split_mode text NOT NULL CHECK (split_mode IN ('equal', 'custom', 'percentage', 'itemized')),
  due_date date,
  receipt_url text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_circle_idx ON expenses (circle_id, created_at DESC);

CREATE TABLE expense_participants (
  expense_id uuid NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  allocation_minor bigint NOT NULL CHECK (allocation_minor >= 0),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'accepted', 'due', 'payment_reported', 'payment_verified',
                      'disputed', 'settled', 'waived', 'cancelled')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (expense_id, user_id)
);

-- Append-only audit trail for an expense. Corrections are new events, never
-- silent edits.
CREATE TABLE expense_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  type text NOT NULL,
  from_status text,
  to_status text,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expense_events_expense_idx ON expense_events (expense_id, created_at);

-- A reported payment is not a verified payment. These are distinct columns.
CREATE TABLE payment_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id uuid NOT NULL REFERENCES expenses (id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  status text NOT NULL DEFAULT 'reported'
    CHECK (status IN ('reported', 'verified', 'disputed', 'rejected')),
  verification_source text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE INDEX payment_reports_expense_idx ON payment_reports (expense_id);

-- Provider webhook inbox. The primary key on the provider event id makes
-- duplicate delivery a no-op.
CREATE TABLE provider_webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  route text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  status_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, route, key)
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('user', 'post', 'comment', 'activity', 'circle', 'ad')),
  target_id uuid NOT NULL,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'actioned', 'dismissed', 'appealed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_status_idx ON reports (status, created_at);

CREATE TABLE moderation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid REFERENCES reports (id) ON DELETE SET NULL,
  assignee_id uuid REFERENCES users (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'resolved', 'appealed')),
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES moderation_cases (id) ON DELETE SET NULL,
  actor_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type text NOT NULL,
  entity_type text,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
