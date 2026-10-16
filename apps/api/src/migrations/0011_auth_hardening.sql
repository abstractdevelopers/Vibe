-- 0011_auth_hardening.sql
--
-- Password reset, a transactional email outbox, and the rate-limit store.
--
-- The email outbox exists so that "send an email" is never a step that can
-- silently fail inside a request. The reset request writes a token and an
-- outbox row in one transaction; a worker drains the outbox. In development the
-- worker logs the message instead of sending it, so the flow is testable
-- without an email provider.

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Only the hash is stored, exactly like session tokens.
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_user_idx ON password_resets (user_id, created_at DESC);

CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  -- Set once the mailer has accepted it, so the worker never sends twice.
  sent_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_pending_idx ON email_outbox (sent_at, created_at);

-- Rate limiting. A table rather than Redis: the deployment is a single server
-- with one application instance, so this is sufficient and has no extra moving
-- part. It is written with an atomic upsert so concurrent requests cannot race
-- past the limit. If the deployment later grows past one instance, this becomes
-- a Redis counter behind the same interface (see modules/ratelimit.ts).
CREATE TABLE rate_limit_counters (
  bucket text PRIMARY KEY,
  count int NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_limit_window_idx ON rate_limit_counters (window_started_at);
