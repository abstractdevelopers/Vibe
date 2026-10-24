-- Limited editions: a cosmetic can be a numbered run.
--
-- A frame or an outfit that anyone can buy at any time is a purchase, not a
-- status object. An edition is finite: once the run is sold, it is sold, and
-- every owner holds a numbered copy ("Gold · No. 7 of 100"). The number is
-- assigned at purchase and never changes, so it is a receipt rather than a
-- claim - and the count of sold copies is the count of rows, never a counter
-- that could drift.
--
-- `serial` is NULL for an open (unlimited) cosmetic, so existing rows and the
-- cheap everyday looks keep working unchanged.

ALTER TABLE cosmetic_purchases
  ADD COLUMN serial integer CHECK (serial IS NULL OR serial > 0),
  ADD COLUMN edition_size integer CHECK (edition_size IS NULL OR edition_size > 0);

-- Two people can never hold the same number of the same edition. The partial
-- index leaves unlimited cosmetics out of the constraint entirely.
CREATE UNIQUE INDEX cosmetic_purchases_edition_serial
  ON cosmetic_purchases (cosmetic_id, serial)
  WHERE serial IS NOT NULL;

-- The run size is written onto the purchase so a later change to the catalogue
-- cannot rewrite history: a buyer of "1 of 100" still holds "1 of 100" even if
-- the catalogue is later reissued with a different run.
CREATE INDEX cosmetic_purchases_cosmetic
  ON cosmetic_purchases (cosmetic_id);
