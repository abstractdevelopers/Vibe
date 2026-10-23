-- A campaign now has a price per served impression, so its budget is a limit
-- rather than a number the console merely displays. Spend is derived from
-- `ad_deliveries` (the server's verified serving record), never stored as a
-- mutable counter, so the same rule as the money ledger applies: a total is a
-- SUM over facts.
ALTER TABLE campaigns
  ADD COLUMN cost_per_impression_minor integer NOT NULL DEFAULT 100
  CHECK (cost_per_impression_minor > 0);
