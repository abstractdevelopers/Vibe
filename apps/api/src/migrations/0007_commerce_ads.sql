-- Payment provider integration hardening.
--
-- 1. The webhook inbox stores the provider's own reference so an attempt can be
--    looked up directly instead of scanning the payload JSON.
-- 2. The order state machine (§4.7) so a verified webhook can advance an order
--    through its states rather than merely being recorded.
-- 3. Merchant storefront + product catalog and ad campaigns (§4.8, §4.7).

ALTER TABLE provider_webhook_events ADD COLUMN provider_ref text;
CREATE INDEX provider_webhook_ref_idx ON provider_webhook_events (provider_ref);

-- ---- Commerce: merchants, products, orders ----------------------------------

CREATE TABLE merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  category text,
  -- Verification is an operator action; unverified merchants cannot publish
  -- products. Kept explicit rather than inferred.
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  policies text,
  contact_route text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchants_owner_idx ON merchants (owner_id);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL,
  availability text NOT NULL DEFAULT 'in_stock'
    CHECK (availability IN ('in_stock', 'out_of_stock', 'preorder', 'discontinued')),
  fulfillment text,
  refund_policy text,
  media_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_merchant_idx ON products (merchant_id, created_at DESC);

-- Order lifecycle per §4.7. Only a verified provider webhook may move an order
-- into a paid/confirmed state.
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'awaiting_payment', 'payment_processing', 'paid',
                      'seller_confirmed', 'fulfilling', 'completed', 'cancelled',
                      'failed', 'refund_pending', 'refunded', 'disputed')),
  amount_minor integer NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  provider text,
  provider_ref text,
  reference text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_buyer_idx ON orders (buyer_id, created_at DESC);
CREATE INDEX orders_provider_ref_idx ON orders (provider, provider_ref);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id uuid REFERENCES products (id) ON DELETE SET NULL,
  name text NOT NULL,
  unit_amount_minor integer NOT NULL CHECK (unit_amount_minor >= 0),
  quantity integer NOT NULL CHECK (quantity > 0),
  currency text NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- Every order state change is recorded, so the history is auditable and a
-- duplicate webhook cannot silently re-apply a transition.
CREATE TABLE order_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

-- ---- Advertising: campaigns (§4.8) ------------------------------------------

CREATE TABLE campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  merchant_id uuid REFERENCES merchants (id) ON DELETE SET NULL,
  name text NOT NULL,
  objective text NOT NULL,
  creative text NOT NULL,
  destination_url text NOT NULL,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  geography text,
  budget_minor integer NOT NULL CHECK (budget_minor >= 0),
  currency text NOT NULL,
  schedule_start timestamptz,
  schedule_end timestamptz,
  frequency_cap integer NOT NULL DEFAULT 3 CHECK (frequency_cap > 0),
  category text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'scheduled',
                      'active', 'paused', 'completed', 'rejected')),
  moderation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_advertiser_idx ON campaigns (advertiser_id, created_at DESC);
CREATE INDEX campaigns_status_idx ON campaigns (status);
