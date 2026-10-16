-- Phase 4 (IRL and activities) and Phase 5 (Vibe Pass and AI assistance),
-- plus the cross-cutting boundaries: ad delivery/reporting, push tokens,
-- post full-text search.

-- ---- Phase 3 completion: ad delivery + reporting (§4.8) ---------------------
--
-- An approved campaign is delivered as a labelled Sponsored feed item. We keep
-- a first-class delivery record so impressions/clicks are attributable to a
-- campaign and cannot be double-counted (unique (campaign_id, surface,
-- placement_id, viewer_id) for impressions).

ALTER TABLE campaigns ADD COLUMN creative_title text;
ALTER TABLE campaigns ADD COLUMN creative_body text;
ALTER TABLE campaigns ADD COLUMN creative_cta text;
ALTER TABLE campaigns ADD COLUMN landing_merchant_id uuid REFERENCES merchants (id) ON DELETE SET NULL;

CREATE TABLE ad_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  surface text NOT NULL DEFAULT 'feed' CHECK (surface IN ('feed', 'explore')),
  -- Opaque, client-generated id for the placement instance. Combined with the
  -- viewer it makes impression recording idempotent: a retried beacon cannot
  -- inflate reach.
  placement_id text NOT NULL,
  viewer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  served_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, surface, placement_id, viewer_id)
);
CREATE INDEX ad_deliveries_campaign_idx ON ad_deliveries (campaign_id, served_at DESC);

CREATE TABLE ad_impressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES ad_deliveries (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- "verified" impressions come from the server-side served record; a client
  -- beacon is recorded as reported so the two are never conflated.
  source text NOT NULL DEFAULT 'reported' CHECK (source IN ('reported', 'verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id)
);
CREATE INDEX ad_impressions_campaign_idx ON ad_impressions (campaign_id, created_at DESC);

CREATE TABLE ad_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES ad_deliveries (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  viewer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id)
);
CREATE INDEX ad_clicks_campaign_idx ON ad_clicks (campaign_id, created_at DESC);

-- A person's ad preferences: campaigns they have hidden, so delivery respects it.
CREATE TABLE ad_preferences (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, campaign_id)
);

-- ---- Phase 4: events, ticketing boundary, check-in --------------------------

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  merchant_id uuid REFERENCES merchants (id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'UTC',
  -- Coarse location only: city/area strings, never precise coordinates.
  place text,
  city text,
  area text,
  price_minor integer NOT NULL DEFAULT 0 CHECK (price_minor >= 0),
  currency text NOT NULL DEFAULT 'NGN',
  -- Ticketing is a provider/merchant boundary. An event is not a ticket; this
  -- records whether a verified booking exists.
  booking_provider text,
  booking_ref text,
  booking_verified boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'cancelled', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_organizer_idx ON events (organizer_id, created_at DESC);
CREATE INDEX events_city_idx ON events (city, starts_at);
CREATE INDEX events_state_idx ON events (state, starts_at);

-- A check-in code is unique, revocable and validated server-side. The code is a
-- random token; nothing sensitive is encoded in the QR itself.
CREATE TABLE checkin_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkin_codes_event_idx ON checkin_codes (event_id);

CREATE TABLE checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_id uuid REFERENCES checkin_codes (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, user_id)
);

-- Shared memories: a memory is a post of type 'memory' attached to a Circle.
-- The post table already carries circle_id/type/metadata, so a memory is just a
-- validated post; this table records who captured it and when it is pinned.

-- ---- Phase 5: Vibe Pass + loyalty (§4.9) ------------------------------------

CREATE TABLE vibe_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The public handle is a random token; the NFC tag / QR points at this, and
  -- the server resolves it to the (revocable) pass row. No personal data is
  -- written to the tag.
  public_token text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  -- What the holder consents to share when a merchant scans them.
  share_display_name boolean NOT NULL DEFAULT true,
  share_avatar boolean NOT NULL DEFAULT true,
  share_handle boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vibe_passes_user_idx ON vibe_passes (user_id);

CREATE TABLE loyalty_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pass_id uuid NOT NULL REFERENCES vibe_passes (id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  -- A nonce makes redemption single-use and prevents duplicate redemption of
  -- the same offer even if a scan is replayed.
  offer_code text NOT NULL,
  nonce text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'rejected', 'expired')),
  redeemed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pass_id, merchant_id, offer_code, nonce)
);
CREATE INDEX loyalty_redemptions_merchant_idx ON loyalty_redemptions (merchant_id, created_at DESC);

-- ---- Cross-cutting: push notification boundary ------------------------------

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  token text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, token)
);

-- ---- Cross-cutting: AI assistance boundary (§4.10) --------------------------
--
-- Suggestions are proposals only. They are stored so a person can review,
-- correct or dismiss one, and so an action is never taken without approval.
CREATE TABLE ai_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('draft_plan', 'summarize_circle', 'suggest_events', 'propose_budget', 'reminder')),
  entity_type text,
  entity_id uuid,
  prompt text,
  output jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'dismissed', 'corrected')),
  provider text NOT NULL DEFAULT 'stub',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_suggestions_user_idx ON ai_suggestions (user_id, created_at DESC);

-- ---- Cross-cutting: post full-text search -----------------------------------

ALTER TABLE posts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;
CREATE INDEX posts_search_idx ON posts USING gin (search_vector);
