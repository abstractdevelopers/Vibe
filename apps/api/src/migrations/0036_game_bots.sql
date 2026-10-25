-- Seats can belong to the house.
--
-- A lone player should not have to wait for a stranger to sit down, so a table
-- can be filled with house players ("bots"). They are ordinary seats backed by
-- an ordinary user row, because `users` already models an `automated` identity
-- kind and every join, view and notification in the product expects a user
-- there. Nulling `game_players.user_id` instead would have quietly dropped bot
-- seats out of the player list on every screen.
--
-- The accounts themselves are NOT seeded here. Creating them at migration time
-- looked right and was wrong: any reset that truncates `users` (the test
-- harness does exactly that) leaves the rows behind with nothing to recreate
-- them, and bot tables then silently seat nobody. They are provisioned on
-- demand instead, by `ensureBotUsers` in the games module, which is idempotent.
--
-- Two rules stop this becoming a money or fairness hole:
--
--   * A bot never stakes and is never paid. `staked_minor` must be 0 (enforced
--     below) and settlement only runs on a pot above zero, which a bot cannot
--     contribute to.
--   * Bots play through the engine's existing `autoMove`, which can only return
--     a legal move for the viewer's own slice of state. It cannot see another
--     player's hand, so the house cannot cheat by construction.

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS bot_level text
    CHECK (bot_level IS NULL OR bot_level IN ('easy', 'steady', 'sharp'));

-- A bot seat must hold no stake. Enforced here so no future route can
-- accidentally introduce a staking bot.
ALTER TABLE game_players
  DROP CONSTRAINT IF EXISTS game_players_bot_no_stake;
ALTER TABLE game_players
  ADD CONSTRAINT game_players_bot_no_stake
  CHECK (bot_level IS NULL OR staked_minor = 0);
