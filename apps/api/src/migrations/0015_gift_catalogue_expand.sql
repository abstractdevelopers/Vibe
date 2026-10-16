-- Expand the paid gift catalogue.
--
-- The original nine gifts stopped at ₦100,000. TikTok Live and similar
-- platforms carry a long ladder from a cheap everyday gift to a full-screen
-- spectacle, which is what makes gifting feel like a live economy rather than a
-- tip jar. This adds the missing rungs (a coffee, fireworks, a guitar solo,
-- diamond, trophy, castle, universe, jet, yacht) between the existing ones.
--
-- The client reads this table, and settlement looks a gift up by id, so adding
-- rows here is all that is required. ON CONFLICT DO NOTHING keeps it safe to
-- re-run and harmless on a database that already has a row.
INSERT INTO gift_catalogue (id, label, hint, emoji, tier, price_minor, currency, fee_bps, sort_order) VALUES
  ('coffee',    'Coffee',        'Buy them a coffee',      '☕',  1,    30000, 'NGN', 3000,  15),
  ('fireworks', 'Fireworks',     'Celebrate big',          '🎆',  2,   300000, 'NGN', 3000,  45),
  ('guitar',    'Guitar solo',   'A riff for them',        '🎸',  2,   400000, 'NGN', 3000,  48),
  ('diamond',   'Diamond',       'Rare and precious',      '💎',  3,  2000000, 'NGN', 3000,  65),
  ('trophy',    'Trophy',        'Champion',               '🏆',  3,  3000000, 'NGN', 3000,  75),
  ('castle',    'Castle',        'Build them an empire',   '🏰',  3,  7500000, 'NGN', 3000,  85),
  ('universe',  'Universe',      'Beyond everything',      '🪐',  3, 15000000, 'NGN', 3000,  95),
  ('jet',       'Private jet',   'Arrive in style',        '🛩️', 3, 20000000, 'NGN', 3000, 100),
  ('yacht',     'Yacht',         'Sailing in style',       '🛥️', 3, 30000000, 'NGN', 3000, 110)
ON CONFLICT (id) DO NOTHING;
