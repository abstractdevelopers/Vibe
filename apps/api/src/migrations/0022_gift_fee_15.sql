-- Lower the platform's cut on paid gifts from 30% to 15%.
--
-- The rate lives per row in `gift_catalogue`, so this is a data change, not a
-- code constant. `gift_catalogue.fee_bps` is what `POST /v1/money/gifts/purchase`
-- actually charges; the `GIFT_FEE_BPS` constant only seeds the TS catalogue used
-- for display and tests. A live purchase is the source of truth, so the rows
-- must move together with the constant.

UPDATE gift_catalogue SET fee_bps = 1500 WHERE fee_bps = 3000;
