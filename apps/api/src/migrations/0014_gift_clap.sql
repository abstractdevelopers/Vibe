-- Add the Applause gift to the paid catalogue.
--
-- The catalogue was seeded in 0012 and is referenced by id from
-- gift_catalogue; adding one row here is enough for both the picker (which
-- reads the table) and settlement (which looks the gift up by id).
--
-- ON CONFLICT DO NOTHING keeps this safe to re-run and harmless on a database
-- that already has the row.
INSERT INTO gift_catalogue (id, label, hint, emoji, tier, price_minor, currency, fee_bps, sort_order) VALUES
  ('clap', 'Applause', 'Well deserved', '👏', 1, 150000, 'NGN', 3000, 35)
ON CONFLICT (id) DO NOTHING;
