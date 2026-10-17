-- Games: live multiplayer inside Vibe, with optional Yens staking.
--
-- The platform is server-authoritative. The client sends a move, the engine
-- validates it against the stored state, and only then is it persisted and
-- broadcast. A client can never invent a win, and a staked pot only moves when
-- the server decides the game.
--
-- Money: a stake is wallet Yens moved into a `game_pot` escrow account, and a
-- payout moves the pot to the winner with the platform's rake credited to
-- revenue. Both are ordinary journals, so a game cannot create or destroy Yens.

CREATE TABLE game_catalog (
  id text PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('cards', 'board', 'casino', 'mind', 'action', 'party')),
  blurb text NOT NULL,
  min_players integer NOT NULL CHECK (min_players >= 1),
  max_players integer NOT NULL CHECK (max_players >= min_players),
  stake_enabled boolean NOT NULL DEFAULT false,
  -- 'playable' means an engine exists server-side; 'planned' means it is listed
  -- but not yet implemented, and the API will refuse to start it.
  availability text NOT NULL DEFAULT 'planned' CHECK (availability IN ('playable', 'planned')),
  engine text,
  icon text,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO game_catalog (id, name, category, blurb, min_players, max_players, stake_enabled, availability, engine, icon, sort_order) VALUES
  ('whot',       'Whot',          'cards',  'The Nigerian classic. Match suit or number; 20 is wild.', 2, 6, true,  'playable', 'whot',   '🃏', 10),
  ('blackjack',  'Blackjack',     'cards',  'Beat the dealer to 21 without going bust.',              2, 6, true,  'planned',  null,     '♠️', 20),
  ('scrabble',   'Scrabble',      'board',  'Build words on the board for the highest score.',        2, 4, true,  'planned',  null,     '🔤', 30),
  ('monopoly',   'Monopoly',      'board',  'Buy, trade and bankrupt your way to the top.',           2, 6, true,  'planned',  null,     '🎩', 40),
  ('chess',      'Chess',         'board',  'The classic game of strategy.',                          2, 2, true,  'planned',  null,     '♞', 50),
  ('checkers',   'Checkers',      'board',  'Jump and crown your way to a win.',                      2, 2, true,  'planned',  null,     '⚫', 60),
  ('ludo',       'Ludo',          'board',  'Race four tokens home.',                                 2, 4, true,  'planned',  null,     '🎲', 70),
  ('ayo',        'Ayo (Mancala)','board',  'Sow and capture in the Yoruba classic.',                 2, 2, true,  'planned',  null,     '🪙', 80),
  ('draft',      'Draughts',      'board',  'A fast, tactical board duel.',                           2, 2, true,  'planned',  null,     '⭕', 90),
  ('snakes',     'Snakes & Ladders','board','Roll, climb and slide to the finish.',                  2, 4, false, 'planned',  null,     '🐍', 100),
  ('scramble',   'Word Scramble', 'mind',   'Unscramble the word before the timer runs out.',         2, 8, true,  'planned',  null,     '🔠', 110),
  ('trivia',     'Trivia Duel',   'mind',   'Head-to-head general knowledge.',                        2, 8, true,  'planned',  null,     '🧠', 120),
  ('tictactoe',  'Tic-Tac-Toe',   'mind',   'Three in a row. Simple, brutal.',                        2, 2, true,  'planned',  null,     '❌', 130),
  ('connect4',   'Connect Four',  'mind',   'Line up four before your opponent does.',                2, 2, true,  'planned',  null,     '🔴', 140),
  ('reversi',    'Reversi',       'mind',   'Flip your way to the most discs.',                       2, 2, true,  'planned',  null,     '⚪', 150),
  ('sudoku',     'Sudoku Race',   'mind',   'Solve the grid fastest against a rival.',                2, 4, false, 'planned',  null,     '🔢', 160),
  ('memory',     'Memory Match',  'mind',   'Find the pairs; most matches wins.',                     2, 4, true,  'planned',  null,     '🃏', 170),
  ('20q',        '20 Questions',  'party',  'Guess what they are thinking in twenty questions.',      2, 8, false, 'planned',  null,     '❓', 180),
  ('charades',   'Charades',      'party',  'Act it out; your team guesses.',                         4, 12, false,'planned',  null,     '🎭', 190),
  ('truthdare',  'Truth or Dare', 'party',  'The classic party icebreaker.',                          2, 12, false,'planned',  null,     '🎯', 200),
  ('neverhave',  'Never Have I Ever','party','Reveal and react.',                                     3, 12, false,'planned',  null,     '🙈', 210),
  ('wyr',        'Would You Rather','party', 'Pick a side and defend it.',                            2, 12, false,'planned',  null,     '🤔', 220),
  ('dice',       'Dice Duel',     'casino', 'Highest roll takes the pot.',                            2, 6, true,  'planned',  null,     '🎲', 230),
  ('roulette',   'Roulette',      'casino', 'Spin the wheel.',                                        2, 8, true,  'planned',  null,     '🎡', 240),
  ('slots',      'Slots',         'casino', 'Match the reels.',                                       1, 1, true,  'planned',  null,     '🎰', 250),
  ('poker',      'Poker (5-card)','casino', 'Best five-card hand wins.',                              2, 6, true,  'planned',  null,     '🂡', 260),
  ('baccarat',   'Baccarat',      'casino', 'Player or banker — closest to nine.',                    2, 8, true,  'planned',  null,     '🎴', 270),
  ('crash',      'Crash',         'casino', 'Cash out before the curve crashes.',                     2, 10, true, 'planned',  null,     '📈', 280),
  ('plinko',     'Plinko',        'casino', 'Drop the ball; the slots decide.',                       1, 1, true,  'planned',  null,     '🔻', 290),
  ('war',        'War',           'cards',  'Highest card takes the round.',                          2, 2, true,  'planned',  null,     '⚔️', 300),
  ('go',         'Go',            'board',  'Surround more territory than your rival.',               2, 2, true,  'planned',  null,     '⚫', 310),
  ('backgammon', 'Backgammon',    'board',  'Race and block your way home.',                          2, 2, true,  'planned',  null,     '🎲', 320),
  ('dominoes',   'Dominoes',      'board',  'Match the pips; empty your hand.',                       2, 4, true,  'planned',  null,     '🁫', 330),
  ('mancala',    'Mancala',       'board',  'Capture the most stones.',                                2, 2, true,  'planned',  null,     '⚪', 340),
  ('battleship', 'Battleship',    'mind',   'Sink the fleet first.',                                  2, 2, true,  'planned',  null,     '🚢', 350),
  ('dots',       'Dots & Boxes',  'mind',   'Complete the most boxes.',                               2, 4, true,  'planned',  null,     '🔷', 360),
  ('hangman',    'Hangman',       'mind',   'Guess the word before the rope runs out.',               2, 6, false, 'planned',  null,     '🪢', 370),
  ('wordchain',  'Word Chain',    'mind',   'Each word starts with the last letter of the previous.', 2, 8, false, 'planned',  null,     '🔗', 380),
  ('simon',      'Simon Says',    'action', 'Repeat the growing sequence.',                           2, 8, true,  'planned',  null,     '🎵', 390),
  ('reaction',   'Reaction Duel', 'action', 'First to tap wins.',                                     2, 8, true,  'planned',  null,     '⚡', 400),
  ('penalty',    'Penalty Shootout','action','Score more penalties than your rival.',                 2, 2, true,  'planned',  null,     '⚽', 410);

CREATE TABLE game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id text NOT NULL REFERENCES game_catalog (id),
  host_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  circle_id uuid REFERENCES circles (id) ON DELETE SET NULL,
  scope text NOT NULL DEFAULT 'invite' CHECK (scope IN ('circle', 'followers', 'friends', 'strangers', 'invite')),
  status text NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'active', 'finished', 'cancelled')),
  stake_minor bigint NOT NULL DEFAULT 0 CHECK (stake_minor >= 0),
  rake_bps integer NOT NULL DEFAULT 500 CHECK (rake_bps BETWEEN 0 AND 10000),
  currency text NOT NULL DEFAULT 'NGN',
  pot_minor bigint NOT NULL DEFAULT 0,
  winner_id uuid REFERENCES users (id) ON DELETE SET NULL,
  state jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX game_sessions_open_idx ON game_sessions (game_id, status) WHERE status IN ('lobby', 'active');

CREATE TABLE game_players (
  session_id uuid NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seat integer NOT NULL,
  status text NOT NULL DEFAULT 'joined' CHECK (status IN ('joined', 'ready', 'left', 'forfeited')),
  staked_minor bigint NOT NULL DEFAULT 0,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

-- Every accepted move, in order, so a game is reconstructable and a replayed
-- move (same sequence) cannot be applied twice.
CREATE TABLE game_moves (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES game_sessions (id) ON DELETE CASCADE,
  seq integer NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  move jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

-- The escrow account for staked Yens, plus the journals a game produces.
ALTER TABLE ledger_accounts DROP CONSTRAINT ledger_accounts_kind_check;
ALTER TABLE ledger_accounts ADD CONSTRAINT ledger_accounts_kind_check
  CHECK (kind IN (
    'creator_earnings', 'platform_revenue', 'provider_clearing', 'provider_fee',
    'creator_payouts', 'gift_refunds', 'user_wallet', 'game_pot'
  ));

ALTER TABLE ledger_journals DROP CONSTRAINT ledger_journals_kind_check;
ALTER TABLE ledger_journals ADD CONSTRAINT ledger_journals_kind_check
  CHECK (kind IN (
    'gift_purchase', 'gift_refund', 'creator_payout', 'payout_reversal',
    'ticket_purchase', 'ticket_refund', 'adjustment',
    'wallet_topup', 'wallet_transfer', 'wallet_spend',
    'order_purchase', 'order_refund',
    'game_stake', 'game_payout', 'game_refund'
  ));

ALTER TABLE game_sessions ADD COLUMN journal_id uuid REFERENCES ledger_journals (id) ON DELETE RESTRICT;
