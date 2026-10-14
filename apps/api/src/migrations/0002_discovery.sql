-- Discovery: places and businesses, plus coarse-area data on plans.
--
-- Location is intentionally coarse. The spec says to target and search at
-- city/area granularity and never to expose an individual's precise location,
-- so we store a city + area label, not coordinates. Nothing here is
-- third-party-populated: merchants are seeded as clearly-labelled sample data.

CREATE TABLE places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('shop', 'restaurant', 'venue', 'service', 'other')),
  category text NOT NULL,
  city text NOT NULL,
  area text,
  description text,
  address_hint text,
  price_band smallint CHECK (price_band IS NULL OR price_band BETWEEN 1 AND 4),
  image_url text,
  is_verified boolean NOT NULL DEFAULT false,
  is_sample boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX places_city_idx ON places (city, category);
CREATE INDEX places_name_idx ON places (lower(name));

-- Coarse area on plans so an outing can be discovered by area without ever
-- storing a precise point. Existing rows simply have NULL.
ALTER TABLE plans ADD COLUMN city text;
ALTER TABLE plans ADD COLUMN area text;
ALTER TABLE plans ADD COLUMN discoverable boolean NOT NULL DEFAULT false;
CREATE INDEX plans_discovery_idx ON plans (discoverable, starts_at);

-- The viewer's chosen city/area for discovery. This is a coarse preference, not
-- a tracked location: we never store coordinates and never record a device fix.
ALTER TABLE users ADD COLUMN city text;
ALTER TABLE users ADD COLUMN area text;

-- Sample places, clearly marked, so Explore is demonstrable without inventing
-- real businesses or fabricated counts.
INSERT INTO places (name, kind, category, city, area, description, address_hint, price_band, is_verified, is_sample) VALUES
  ('Tarkwa Bay Beach', 'venue', 'outdoors', 'Lagos', 'Tarkwa Bay', 'Calm sheltered beach reachable by boat.', 'Take a boat from Victoria Island', 2, false, true),
  ('Landmark Beach', 'venue', 'outdoors', 'Lagos', 'Victoria Island', 'Beach club with food, games and live music.', 'Water Corporation Road', 3, false, true),
  ('Bogobiri House', 'restaurant', 'food', 'Lagos', 'Ikoyi', 'Art-filled Afro-Caribbean kitchen with live sets.', '9 Maitama Sule Street', 3, false, true),
  ('Nike Art Gallery', 'venue', 'culture', 'Lagos', 'Lekki', 'Four floors of Nigerian art and craft.', '2 Elegushi Beach Road', 1, false, true),
  ('The Palms Mall', 'shop', 'retail', 'Lagos', 'Lekki', 'Cinema, food court and shops under one roof.', '1 Bisway Gardens', 2, false, true),
  ('Freedom Park', 'venue', 'culture', 'Lagos', 'Lagos Island', 'Open-air concerts and theatre in a former prison yard.', '1 Hospital Road', 1, false, true),
  ('Rooftop VI', 'restaurant', 'nightlife', 'Lagos', 'Victoria Island', 'Rooftop bar with skyline views.', 'Adeola Odeku Street', 3, false, true),
  ('Mama Cass Restaurant', 'restaurant', 'food', 'Lagos', 'Yaba', 'Long-running local kitchen, generous portions.', 'Herbert Macaulay Way', 1, false, true),
  ('Vibes FM Studio', 'service', 'media', 'Lagos', 'Surulere', 'Community radio and podcast studio.', 'Bode Thomas Street', 1, false, true),
  ('Jabi Lake Mall', 'shop', 'retail', 'Abuja', 'Jabi', 'Lakeside mall with cinema and restaurants.', 'Jabi Lake', 2, false, true),
  ('Millennium Park', 'venue', 'outdoors', 'Abuja', 'Maitama', 'Landscaped park for walks and picnics.', 'Maitama', 1, false, true),
  ('Wuse Market', 'shop', 'retail', 'Abuja', 'Wuse', 'Bustling market for fabric, food and everyday goods.', 'Wuse Zone 3', 1, false, true);
