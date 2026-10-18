/**
 * Game notes for the hub.
 *
 * The catalogue stores a blurb and a player range, but a player about to sit
 * down wants to know how the thing is won. These are short, honest rules for
 * every playable title, kept beside the catalogue rather than in the database
 * because they change with the engine, not with the operator.
 *
 * Anything without an entry falls back to its blurb, so a new game in the
 * catalogue is never shown with an empty panel.
 */

export interface GameNote {
  /** One line on how you win. */
  goal: string;
  /** How a turn works, in a sentence. */
  turn: string;
}

export const GAME_NOTES: Record<string, GameNote> = {
  // Cards
  whot: {
    goal: "Be first to empty your hand.",
    turn: "Match the top card by shape or number; pick up if you cannot.",
  },
  blackjack: {
    goal: "Get closer to 21 than the dealer without going over.",
    turn: "Hit for another card or stand; face cards count ten, aces count one or eleven.",
  },
  war: {
    goal: "Take every card in the deck.",
    turn: "Each side turns a card; the higher card takes the pair, ties go to a pile.",
  },
  gofish: {
    goal: "Collect the most books of four.",
    turn: "Ask a rival for a rank; if they have none, you fish from the deck.",
  },
  crazyeights: {
    goal: "Be first to empty your hand.",
    turn: "Play a card matching the suit or rank; eights are wild and change the suit.",
  },
  poker: {
    goal: "Hold the best five-card hand, or make everyone fold.",
    turn: "You get one draw; bet, call or fold on what you hold.",
  },
  baccarat: {
    goal: "Back the hand closest to nine.",
    turn: "Bet on Player, Banker or Tie, then the hands are dealt and compared.",
  },

  // Board
  tictactoe: {
    goal: "Line up three of your mark.",
    turn: "Place one mark on any free square.",
  },
  connect4: {
    goal: "Line up four in a row.",
    turn: "Drop a disc into a column; it falls to the lowest free slot.",
  },
  gomoku: {
    goal: "Line up five in a row.",
    turn: "Place one stone on the grid; five in any direction wins.",
  },
  checkers: {
    goal: "Capture every rival piece, or block them so they cannot move.",
    turn: "Move diagonally and jump a rival to capture it; reach the far row to crown a king.",
  },
  reversi: {
    goal: "Hold the most discs when the board fills.",
    turn: "Place a disc to trap rival discs between two of yours, then they flip to your colour.",
  },
  battleship: {
    goal: "Sink every rival ship.",
    turn: "Call a square; you are told a hit or a miss, and fire again on a hit.",
  },
  dots: {
    goal: "Close the most boxes.",
    turn: "Draw a line between two dots; close the fourth side of a box to claim it and go again.",
  },
  snakes: {
    goal: "Reach the last square first.",
    turn: "Roll and move; ladders lift you up and snakes drop you down.",
  },

  // Mind
  memory: {
    goal: "Find the most matching pairs.",
    turn: "Turn two cards; a pair stays face up and you go again.",
  },
  hangman: {
    goal: "Guess the word before the drawing is complete.",
    turn: "Call a letter; a wrong call costs one of six lives.",
  },
  wordchain: {
    goal: "Outlast everyone on the chain.",
    turn: "Say a word starting with the last letter of the word before it.",
  },
  trivia: {
    goal: "Answer more questions correctly than your rival.",
    turn: "Pick one of the offered answers; speed breaks a tie.",
  },
  scramble: {
    goal: "Unscramble the most words in the time.",
    turn: "Rearrange the letters into a real word and submit it.",
  },

  // Action
  simon: {
    goal: "Repeat the sequence without a mistake.",
    turn: "Watch the pattern, then tap it back; it grows by one each round.",
  },
  reaction: {
    goal: "Be the fastest to react.",
    turn: "Wait for the signal, then tap; tapping early is a false start.",
  },
  penalty: {
    goal: "Score more penalties than your rival.",
    turn: "Pick a corner to shoot or to dive; the keeper guesses the other way.",
  },
  rps: {
    goal: "Win the best of five.",
    turn: "Throw rock, paper or scissors at the same time as your rival.",
  },

  // Casino
  dice: {
    goal: "Call the dice and beat your rival.",
    turn: "Bet, then the dice are rolled; the higher total takes the round.",
  },
  roulette: {
    goal: "Back the number, colour or range the ball lands on.",
    turn: "Place a bet, then the wheel spins and the ball settles.",
  },
  slots: {
    goal: "Line up matching symbols.",
    turn: "Set your stake and spin; the reels decide.",
  },
  crash: {
    goal: "Cash out before the multiplier crashes.",
    turn: "The multiplier climbs; take your winnings or lose the stake when it busts.",
  },
  plinko: {
    goal: "Land the ball in a high-value slot.",
    turn: "Drop the ball and let it bounce down the pegs.",
  },

  // Party
  wyr: {
    goal: "Pick a side and see who agrees with you.",
    turn: "Two options, one choice, then the room votes.",
  },
  neverhave: {
    goal: "Be the last one standing with lives left.",
    turn: "Admit to a thing, or spend a life.",
  },
  truthdare: {
    goal: "Keep the game going and take the dare.",
    turn: "Pick truth for a question or dare for a challenge.",
  },
  charades: {
    goal: "Get your team to guess the word.",
    turn: "Act it out without speaking while your team guesses.",
  },
};

export function noteFor(gameId: string, blurb: string): GameNote {
  return GAME_NOTES[gameId] ?? { goal: blurb, turn: "Sit down and the table will show you what to do." };
}
