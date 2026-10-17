-- Mark every game that now has a server-side engine as playable.
--
-- 0023 seeded the catalogue with all games `planned` and only Whot `playable`.
-- The engine contract (src/games/engine.ts) and the engines in
-- src/games/{cards,board,mind,party}.ts now back most of the catalogue, so this
-- flips them on. Any id not listed here keeps its current availability.

-- A few new games that only exist now that there is an engine for them.
INSERT INTO game_catalog (id, name, category, blurb, min_players, max_players, stake_enabled, availability, engine, icon, sort_order) VALUES
  ('gomoku',      'Gomoku',         'board',  'Line up five in a row on a big grid.',        2, 2, true,  'playable', 'gomoku',      '⬜', 355),
  ('gofish',      'Go Fish',        'cards',  'Ask for ranks and collect books of four.',    2, 4, true,  'playable', 'gofish',      '🐟', 305),
  ('crazyeights', 'Crazy Eights',   'cards',  'Match suit or rank; eights are wild.',        2, 4, true,  'playable', 'crazyeights', '8️⃣', 315),
  ('rps',         'Rock Paper Scissors','action','Best of five against your rival.',          2, 2, true,  'playable', 'rps',         '✊', 405)
ON CONFLICT (id) DO NOTHING;

UPDATE game_catalog SET availability = 'playable', engine = id WHERE id IN (
  'whot',
  -- cards
  'blackjack', 'war', 'gofish', 'crazyeights', 'poker', 'baccarat',
  -- board
  'tictactoe', 'connect4', 'gomoku', 'checkers', 'reversi', 'battleship', 'dots', 'snakes',
  -- mind / action
  'memory', 'hangman', 'wordchain', 'simon', 'trivia',
  'dice', 'slots', 'roulette', 'crash', 'plinko', 'penalty', 'reaction', 'rps',
  -- party
  'wyr', 'neverhave', 'truthdare', 'charades'
);

-- Games whose catalogue id differs from their engine id.
UPDATE game_catalog SET availability = 'playable', engine = 'wordscramble' WHERE id = 'scramble';
UPDATE game_catalog SET availability = 'playable', engine = 'twentyq'      WHERE id = '20q';

-- Games that are listed but have no engine yet stay honest.
UPDATE game_catalog SET availability = 'planned', engine = NULL
 WHERE id IN ('scrabble', 'monopoly', 'chess', 'ludo', 'ayo', 'draft', 'sudoku', 'go', 'backgammon', 'dominoes', 'mancala');
