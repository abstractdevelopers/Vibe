-- Account lifecycle, notification preferences, post revisions, analytics.
--
-- Three spec gaps closed here, all Phase 1/2 scope:
--   1. Notification preferences by type plus quiet hours (§3, §8, §10).
--   2. Account deletion and data export (§3, §8, §11, §13).
--   3. Post edit history, so an edit is a revision rather than a silent write
--      (§4.2: draft -> published -> edited (revision history)).
--
-- Analytics events live here too. The spec is explicit that event payloads must
-- not carry message bodies, payment data, or unnecessary personal information,
-- so the table stores a pseudonymous user id and small allow-listed properties
-- only. Rows are pruned by retention policy (see modules/analytics.ts).

-- ---------------------------------------------------------------------------
-- Notification preferences
-- ---------------------------------------------------------------------------
-- Per-type opt-out plus quiet hours. Quiet hours are stored as a half-open
-- local window in the user's own timezone offset so no location data is needed.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS quiet_hours_start smallint
    CHECK (quiet_hours_start IS NULL OR (quiet_hours_start BETWEEN 0 AND 23)),
  ADD COLUMN IF NOT EXISTS quiet_hours_end smallint
    CHECK (quiet_hours_end IS NULL OR (quiet_hours_end BETWEEN 0 AND 23)),
  ADD COLUMN IF NOT EXISTS quiet_hours_enabled boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Post revisions
-- ---------------------------------------------------------------------------
-- Every edit writes a row holding the *previous* body. The live body stays on
-- posts.body so the feed read path is unchanged. This is append-only, matching
-- the expense audit-trail discipline: corrections are new records, not silent
-- overwrites.
CREATE TABLE IF NOT EXISTS post_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES posts (id) ON DELETE CASCADE,
  editor_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  previous_body text,
  new_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS post_revisions_post_idx ON post_revisions (post_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Account lifecycle
-- ---------------------------------------------------------------------------
-- Deletion is a request with a cooling-off window, not an instant destructive
-- action: the user can cancel during the window, and the account is only
-- anonymised/removed after it. The row records intent so the workflow is
-- auditable and reversible, as §13 requires.
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'cancelled', 'completed')),
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  execute_after timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS account_deletion_user_idx ON account_deletion_requests (user_id, status);

-- ---------------------------------------------------------------------------
-- Analytics events
-- ---------------------------------------------------------------------------
-- Pseudonymous, allow-listed, append-only. No message bodies, no payment data.
CREATE TABLE IF NOT EXISTS analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  app_version text,
  source text,
  consent boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_name_idx ON analytics_events (name, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events (user_id, created_at DESC);
