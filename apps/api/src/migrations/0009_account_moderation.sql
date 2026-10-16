-- Account moderation status (§9). Admin actions against an account need a
-- durable, enforced state — not just an audit row — so a suspended or banned
-- account cannot keep acting through an existing session.

ALTER TABLE users ADD COLUMN moderation_status text NOT NULL DEFAULT 'active'
  CHECK (moderation_status IN ('active', 'warned', 'restricted', 'suspended', 'banned'));
ALTER TABLE users ADD COLUMN moderation_until timestamptz;
ALTER TABLE users ADD COLUMN moderation_reason text;

CREATE INDEX users_moderation_status_idx ON users (moderation_status);
