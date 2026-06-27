import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyOutcome, nextBoard, turnColor } from '../src/game.js';

const info = (o) => ({ color: 'white', opp: 'black', ownPocketed: 0, oppPocketed: 0, queenPocketed: false, strikerPocketed: false, ...o });

// win a board for `color`: pocket all 9 men (queen already resolved)
function winBoard(s, color, oppPotted = 0) {
  s.pocketed[color] = 8;
  s.pocketed[color === 'white' ? 'black' : 'white'] = oppPotted;
  if (s.turn !== (color === 'white' ? 0 : 1)) s.turn = color === 'white' ? 0 : 1;
  applyOutcome(s, { color, opp: color === 'white' ? 'black' : 'white', ownPocketed: 1, oppPocketed: 0, queenPocketed: false, strikerPocketed: false });
}

test('board winner scores one point per opponent man left', () => {
  const s = newGame();
  winBoard(s, 'white', 2); // black potted 2 -> 7 remain
  assert.equal(s.score.white, 7);
  assert.equal(s.boards, 1);
});

test('securing the queen adds 3 points to the board win', () => {
  const s = newGame();
  s.queen = 'white'; // white covered the queen earlier this board
  winBoard(s, 'white', 0);
  assert.equal(s.score.white, 9 + 3);
});

test('queen secured by the loser gives the winner no bonus', () => {
  const s = newGame();
  s.queen = 'black';
  winBoard(s, 'white', 0);
  assert.equal(s.score.white, 9);
});

test('queen scores nothing once the winner is at the cap', () => {
  const s = newGame();
  s.score.white = 22; // at the cap
  s.queen = 'white';
  winBoard(s, 'white', 0); // +9 coins, queen bonus suppressed
  assert.equal(s.score.white, 22 + 9); // no +3
});

test('match ends at the target score', () => {
  const s = newGame();
  s.score.white = 20;
  winBoard(s, 'white', 4); // +5 -> 25
  assert.equal(s.matchWinner, 'white');
});

test('match ends after the max boards, higher score wins', () => {
  const s = newGame();
  s.boards = 7;
  s.score.white = 6;
  s.score.black = 4;
  winBoard(s, 'white', 8); // +1 -> 7, boards -> 8
  assert.equal(s.boards, 8);
  assert.equal(s.matchWinner, 'white');
});

test('nextBoard resets the board, keeps the score, alternates the break', () => {
  const s = newGame();
  assert.equal(turnColor(s), 'white'); // board 1 break
  winBoard(s, 'white', 3);
  const scoreAfter = s.score.white;
  nextBoard(s);
  assert.equal(s.winner, null);
  assert.equal(s.pocketed.white, 0);
  assert.equal(s.queen, 'board');
  assert.equal(s.score.white, scoreAfter); // score carried over
  assert.equal(turnColor(s), 'black'); // break alternated to board 2
});

test('nextBoard is a no-op once the match is over', () => {
  const s = newGame();
  s.score.white = 24;
  winBoard(s, 'white', 8); // +1 -> 25, match over
  assert.equal(s.matchWinner, 'white');
  nextBoard(s);
  assert.equal(s.winner, 'white'); // unchanged
});
