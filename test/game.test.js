import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, applyOutcome, takeShot, turnColor, strikerHome } from '../src/game.js';

const info = (o) => ({ color: 'white', opp: 'black', ownPocketed: 0, oppPocketed: 0, queenPocketed: false, strikerPocketed: false, ...o });
const whiteOnBoard = (s) => s.pieces.filter((p) => p.color === 'white').length;
const blackOnBoard = (s) => s.pieces.filter((p) => p.color === 'black').length;
const queenOnBoard = (s) => s.pieces.some((p) => p.color === 'queen');

test('new game: 9 white + 9 black + queen, white to break', () => {
  const s = newGame();
  assert.equal(whiteOnBoard(s), 9);
  assert.equal(blackOnBoard(s), 9);
  assert.ok(queenOnBoard(s));
  assert.equal(turnColor(s), 'white');
});

test('clean own pocket continues the turn', () => {
  const s = newGame();
  const r = applyOutcome(s, info({ ownPocketed: 1 }));
  assert.ok(r.continues);
  assert.equal(turnColor(s), 'white');
  assert.equal(s.pocketed.white, 1);
});

test('a miss passes the turn', () => {
  const s = newGame();
  const r = applyOutcome(s, info({}));
  assert.ok(!r.continues);
  assert.equal(turnColor(s), 'black');
});

test('striker foul passes the turn and returns one potted man', () => {
  const s = newGame();
  s.pocketed.white = 3;
  applyOutcome(s, info({ strikerPocketed: true }));
  assert.equal(turnColor(s), 'black');
  assert.equal(s.pocketed.white, 2); // penalty
});

test('foul with no potted men just passes the turn', () => {
  const s = newGame();
  applyOutcome(s, info({ strikerPocketed: true }));
  assert.equal(turnColor(s), 'black');
  assert.equal(s.pocketed.white, 0);
});

test("opponent's man is credited to the opponent and passes the turn", () => {
  const s = newGame();
  applyOutcome(s, info({ oppPocketed: 1 }));
  assert.equal(s.pocketed.black, 1);
  assert.equal(turnColor(s), 'black');
});

test('queen + own man on the same shot covers it immediately', () => {
  const s = newGame();
  const r = applyOutcome(s, info({ ownPocketed: 1, queenPocketed: true }));
  assert.equal(s.queen, 'white');
  assert.ok(r.continues);
});

test('queen alone goes pending and the player continues to cover', () => {
  const s = newGame();
  const r = applyOutcome(s, info({ queenPocketed: true }));
  assert.equal(s.queen, 'pending');
  assert.ok(r.continues);
});

test('pending queen covered on the next stroke', () => {
  const s = newGame();
  s.queen = 'pending';
  applyOutcome(s, info({ ownPocketed: 1 }));
  assert.equal(s.queen, 'white');
});

test('pending queen not covered is returned and the turn passes', () => {
  const s = newGame();
  s.queen = 'pending';
  applyOutcome(s, info({}));
  assert.equal(s.queen, 'board');
  assert.ok(queenOnBoard(s));
  assert.equal(turnColor(s), 'black');
});

test('clearing all 9 men wins the board', () => {
  const s = newGame();
  s.pocketed.white = 8;
  applyOutcome(s, info({ ownPocketed: 1 }));
  assert.equal(s.winner, 'white');
});

test('a failed cover on the last man does not win (queen returns)', () => {
  const s = newGame();
  s.pocketed.white = 8; // one man left, queen owed
  s.queen = 'pending';
  applyOutcome(s, info({})); // cover fails
  assert.equal(s.winner, null);
  assert.equal(s.queen, 'board');
  assert.equal(s.pocketed.white, 8);
});

test('covering with the last man wins with the queen', () => {
  const s = newGame();
  s.pocketed.white = 8;
  s.queen = 'pending';
  applyOutcome(s, info({ ownPocketed: 1 }));
  assert.equal(s.queen, 'white');
  assert.equal(s.winner, 'white');
});

test('three consecutive fouls return an extra coin', () => {
  const s = newGame();
  s.pocketed.white = 5;
  applyOutcome(s, info({ strikerPocketed: true })); // foul 1: -1 -> 4
  applyOutcome(s, info({ strikerPocketed: true })); // foul 2: -1 -> 3
  assert.equal(s.fouls.white, 2);
  applyOutcome(s, info({ strikerPocketed: true })); // foul 3: -1 penalty -1 extra -> 1
  assert.equal(s.pocketed.white, 1);
  assert.equal(s.fouls.white, 0); // streak reset
});

test('a foul with nothing potted owes a due, paid on the next pot', () => {
  const s = newGame();
  applyOutcome(s, info({ strikerPocketed: true })); // foul, no coins to give -> owe one
  assert.equal(s.due.white, 1);
  assert.equal(s.pocketed.white, 0);
  applyOutcome(s, info({ ownPocketed: 1 })); // next pot pays the due (net zero)
  assert.equal(s.due.white, 0);
  assert.equal(s.pocketed.white, 0);
});

test('a clean stroke breaks the foul streak', () => {
  const s = newGame();
  s.pocketed.white = 5;
  applyOutcome(s, info({ strikerPocketed: true })); // foul 1
  assert.equal(s.fouls.white, 1);
  applyOutcome(s, info({ ownPocketed: 1 })); // clean pot resets
  assert.equal(s.fouls.white, 0);
  applyOutcome(s, info({ strikerPocketed: true })); // foul again -> count 1, not 2
  assert.equal(s.fouls.white, 1);
});

test('pieces are conserved across many physics shots', () => {
  let s = newGame();
  const angles = [Math.PI / 2, 1.2, 1.9, 0.6, 2.4, Math.PI / 2 + 0.3];
  for (let i = 0; i < angles.length && !s.winner; i++) {
    const home = strikerHome(turnColor(s));
    const r = takeShot(s, home, angles[i], 4.0);
    assert.ok(!r.timeline.some((x) => x === null));
    // conservation: on-board + credited == 9 per colour; queen always accounted for once
    assert.equal(whiteOnBoard(s) + s.pocketed.white, 9, `white conservation at shot ${i}`);
    assert.equal(blackOnBoard(s) + s.pocketed.black, 9, `black conservation at shot ${i}`);
    const queenAccounted = (queenOnBoard(s) ? 1 : 0) + (s.queen === 'white' || s.queen === 'black' || s.queen === 'pending' ? 1 : 0);
    assert.equal(queenAccounted, 1, `queen accounted at shot ${i}`);
  }
});
