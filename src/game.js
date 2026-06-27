// game.js — 2-player Carrom rules on top of the physics engine.
//
// Singles: player 0 = White (breaks first, baseline at the bottom), player 1 = Black
// (baseline at the top). A turn = place the striker on your baseline and flick.
//
// Rules modelled (simplified ICF):
//   - Pocket >=1 of your own men (cleanly) -> you continue; otherwise the turn passes.
//   - Striker pocketed = foul: any men you potted this shot are returned, one previously
//     potted man is returned as a penalty, and the turn passes. Three consecutive fouls
//     by the same player return one extra coin (then the streak resets).
//   - Opponent's men you pocket are credited to the opponent (they stay down).
//   - Queen (red): pocket it, then "cover" by potting one of your own men on the same or
//     the next stroke. Covered -> the Queen is yours. Not covered -> it returns to centre.
//   - Win the board by pocketing all 9 of your men (with no Queen cover still owed).
//
// resolveShot/takeShot mutate the passed state. The pure rule core (applyOutcome) is
// unit-tested without the physics.

import { Body } from './body.js';
import { simulate } from './simulate.js';
import { PUCK, QUEEN, STRIKER, walls } from './board.js';

export const WHITE = 'white';
export const BLACK = 'black';
export const BASELINE_Y = 0.25; // |y| of each player's baseline
export const BASE_HALF = 0.25; // base-circle ring half-extent
export const BASE_CIRCLE_R = 0.013;
// Largest |x| the striker centre may take: stay between the base circles, no overlap.
export const strikerXLimit = () => BASE_HALF - STRIKER.radius - BASE_CIRCLE_R;

export const turnColor = (s) => (s.turn === 0 ? WHITE : BLACK);
export const oppColor = (c) => (c === WHITE ? BLACK : WHITE);
export const baselineY = (color) => (color === WHITE ? -BASELINE_Y : BASELINE_Y);
export const strikerHome = (color) => ({ x: 0, y: baselineY(color) });

// "Play forward" rule: a stroke must drive the striker away from the player's own baseline
// (into the board) — never sideways (parallel to the baseline) or backward. Forward is +y
// for White (baseline at -y) and -y for Black.
export const FORWARD_MIN_DEG = 2; // minimum forward lean — anything flatter counts as sideways
const FORWARD_MIN_SIN = Math.sin((FORWARD_MIN_DEG * Math.PI) / 180);
export const forwardSign = (color) => (color === WHITE ? 1 : -1);

// Is `angle` (atan2 convention, radians) a legal forward stroke for `color`?
export function isForwardAngle(color, angle) {
  return Math.sin(angle) * forwardSign(color) >= FORWARD_MIN_SIN - 1e-9;
}

// Nearest legal forward angle to `angle`: an already-forward aim is returned unchanged; a
// sideways/backward aim is clamped to the forward limit on the same left/right side.
export function clampForwardAngle(color, angle) {
  if (isForwardAngle(color, angle)) return angle;
  const yc = forwardSign(color) * FORWARD_MIN_SIN;
  const xc = (Math.cos(angle) >= 0 ? 1 : -1) * Math.cos((FORWARD_MIN_DEG * Math.PI) / 180);
  return Math.atan2(yc, xc);
}
const cap = (c) => c[0].toUpperCase() + c.slice(1);
const radiusOf = (color) => (color === 'queen' ? QUEEN.radius : PUCK.radius);

const OPENING_JITTER = 0.0007; // ±0.7mm per axis — tiny, but a chaotic break diverges from it

function openingPieces() {
  const r = PUCK.radius;
  const j = () => (Math.random() * 2 - 1) * OPENING_JITTER;
  // rings spaced with enough gap that the jitter can never overlap two pieces
  const pieces = [{ id: 'queen', color: 'queen', pos: { x: j(), y: j() } }];
  const rings = [
    { n: 6, rad: 2.2 * r, off: 0 },
    { n: 12, rad: 4.3 * r, off: Math.PI / 12 },
  ];
  let id = 0;
  for (const ring of rings) {
    for (let k = 0; k < ring.n; k++) {
      const a = ring.off + (k / ring.n) * Math.PI * 2;
      pieces.push({
        id: `m${id}`,
        color: id % 2 === 0 ? WHITE : BLACK, // 9 white + 9 black
        pos: { x: Math.cos(a) * ring.rad + j(), y: Math.sin(a) * ring.rad + j() },
      });
      id += 1;
    }
  }
  return pieces;
}

export const TARGET = 25; // points to win the match
export const MAX_BOARDS = 8; // or first to TARGET, whichever comes first
export const QUEEN_POINTS = 3;
export const QUEEN_CAP = 22; // queen scores nothing once the winner is on >= this

// Reset the per-board state in place (keeps match score). `breaker` = 0 white, 1 black.
function resetBoard(state, breaker) {
  state.pieces = openingPieces(); // on-board men + queen
  state.pocketed = { white: 0, black: 0 }; // own men credited this board
  state.fouls = { white: 0, black: 0 }; // consecutive fouls per player
  state.due = { white: 0, black: 0 }; // coins owed back (foul penalty with none potted)
  state.queen = 'board'; // 'board' | 'pending' | 'white' | 'black'
  state.turn = breaker;
  state.winner = null; // board winner (null until the board ends)
  state._rc = 0; // returned-piece id counter
  state.message = `${breaker === 0 ? 'White' : 'Black'} to break`;
}

export function newGame() {
  const state = {
    score: { white: 0, black: 0 }, // cumulative match points
    boards: 0, // boards completed
    matchWinner: null, // set when the match ends
    target: TARGET,
    maxBoards: MAX_BOARDS,
  };
  resetBoard(state, 0); // White breaks the first board
  return state;
}

// Start the next board of the match (breaker alternates). No-op once the match is over.
export function nextBoard(state) {
  if (state.matchWinner) return;
  resetBoard(state, state.boards % 2); // alternate the opening break
}

function within(x, y, radius) {
  const w = walls();
  return x >= w.minX + radius && x <= w.maxX - radius && y >= w.minY + radius && y <= w.maxY - radius;
}

// First free spot for a returned piece: centre, then expanding rings.
function freeSpot(state, radius) {
  const fits = (x, y) =>
    within(x, y, radius) &&
    state.pieces.every((p) => {
      const rr = radiusOf(p.color) + radius;
      return (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 >= rr * rr * 0.999;
    });
  if (fits(0, 0)) return { x: 0, y: 0 };
  for (let ring = 1; ring < 14; ring++) {
    const rad = ring * 2.1 * PUCK.radius;
    const m = 6 * ring;
    for (let k = 0; k < m; k++) {
      const a = (k / m) * Math.PI * 2;
      const x = Math.cos(a) * rad;
      const y = Math.sin(a) * rad;
      if (fits(x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function returnMen(state, color, n) {
  for (let i = 0; i < n; i++) {
    state._rc += 1;
    state.pieces.push({ id: `r${color[0]}${state._rc}`, color, pos: freeSpot(state, PUCK.radius) });
  }
}

// A foul penalty: return one potted coin to the board, or owe one (a "due") if none.
function chargePenalty(state, color) {
  if (state.pocketed[color] > 0) {
    state.pocketed[color] -= 1;
    returnMen(state, color, 1);
  } else {
    state.due[color] += 1;
  }
}

// Settle owed coins using ones just potted: each due returns one coin to the board.
function payDue(state, color) {
  let paid = 0;
  while (state.due[color] > 0 && state.pocketed[color] > 0) {
    state.pocketed[color] -= 1;
    returnMen(state, color, 1);
    state.due[color] -= 1;
    paid += 1;
  }
  return paid;
}

function returnQueen(state) {
  state.pieces.push({ id: 'queen', color: 'queen', pos: freeSpot(state, QUEEN.radius) });
  state.queen = 'board';
}

// A board ends when a player clears all 9 of their men (with no queen cover owed).
// The winner scores 1 point per opponent man still on the board, plus 3 for the queen
// if they secured it. The match ends at `target` points or after `maxBoards` boards.
function checkWin(state, color, events) {
  if (state.pocketed[color] < 9 || state.queen === 'pending') return;
  const opp = oppColor(color);
  const oppRemaining = 9 - state.pocketed[opp];
  // queen worth 3, but counts nothing once the winner's running score has reached the cap
  const queenBonus = state.queen === color && state.score[color] < QUEEN_CAP ? QUEEN_POINTS : 0;
  const pts = oppRemaining + queenBonus;
  state.winner = color;
  state.score[color] += pts;
  state.boards += 1;
  events.push(`${cap(color)} wins the board +${pts}${queenBonus ? ' (incl. queen)' : ''}`);

  if (state.score[color] >= state.target) {
    state.matchWinner = color;
  } else if (state.boards >= state.maxBoards) {
    const { white, black } = state.score;
    state.matchWinner = white === black ? 'draw' : white > black ? WHITE : BLACK;
  }
  if (state.matchWinner) {
    events.push(state.matchWinner === 'draw' ? 'Match drawn' : `${cap(state.matchWinner)} wins the match!`);
  }
}

// Pure rule core: apply a classified shot result to the state. Mutates state.
// info: { color, opp, ownPocketed, oppPocketed, queenPocketed, strikerPocketed }
export function applyOutcome(state, info) {
  const { color, opp, ownPocketed, oppPocketed, queenPocketed, strikerPocketed } = info;
  const events = [];

  if (oppPocketed > 0) {
    state.pocketed[opp] += oppPocketed;
    events.push(`${cap(color)} pocketed ${oppPocketed} of ${cap(opp)}'s`);
  }

  if (strikerPocketed) {
    if (ownPocketed > 0) returnMen(state, color, ownPocketed); // potted men don't count on a foul
    if (queenPocketed || state.queen === 'pending') returnQueen(state);
    chargePenalty(state, color); // return a potted coin, or owe one (a "due")
    events.push('Foul: striker pocketed');
    state.fouls[color] += 1;
    if (state.fouls[color] >= 3) {
      chargePenalty(state, color);
      events.push('Three fouls in a row — extra penalty');
      state.fouls[color] = 0;
    }
    state.turn = 1 - state.turn;
    finish(state, color, events, false);
    return { events, continues: false, message: events.join(' · ') };
  }

  state.fouls[color] = 0; // a non-foul stroke ends the foul streak
  if (ownPocketed > 0) {
    state.pocketed[color] += ownPocketed;
    const paid = payDue(state, color); // settle any owed coins with what was just potted
    if (paid > 0) events.push(`paid ${paid} due`);
  }

  if (queenPocketed) {
    if (ownPocketed > 0) {
      state.queen = color;
      events.push('Queen covered!');
    } else {
      state.queen = 'pending';
      events.push('Queen pocketed — cover it');
    }
  } else if (state.queen === 'pending') {
    if (ownPocketed > 0) {
      state.queen = color;
      events.push('Queen covered!');
    } else {
      returnQueen(state);
      events.push('Queen not covered — returned');
    }
  }

  if (ownPocketed > 0) events.push(`${cap(color)} pocketed ${ownPocketed}`);

  const continues = ownPocketed > 0 || (queenPocketed && state.queen === 'pending');
  if (!continues) {
    state.turn = 1 - state.turn;
    if (events.length === 0) events.push(`${cap(color)} missed`);
  }
  finish(state, color, events, continues);
  return { events, continues, message: events.join(' · ') };
}

function finish(state, color, events, continues) {
  checkWin(state, color, events);
  if (!state.winner) {
    events.push(continues ? `${cap(color)} continues` : `${cap(turnColor(state))} to play`);
  }
  state.message = events.join(' · ');
}

// Build the physics bodies for a shot: all on-board pieces + the striker.
export function shotBodies(state, strikerPos) {
  const bodies = state.pieces.map((p) => {
    const b = new Body({
      id: p.id,
      kind: p.color === 'queen' ? 'queen' : 'man',
      pos: { x: p.pos.x, y: p.pos.y },
      radius: radiusOf(p.color),
      mass: p.color === 'queen' ? QUEEN.mass : PUCK.mass,
    });
    b.color = p.color;
    return b;
  });
  bodies.push(new Body({ id: 'striker', kind: 'striker', pos: { x: strikerPos.x, y: strikerPos.y }, radius: STRIKER.radius, mass: STRIKER.mass }));
  return bodies;
}

// Run a shot, classify what was pocketed, update the on-board pieces and apply the rules.
// Returns { timeline, meta, outcome } — meta maps id -> {color, kind, radius} for replay.
export function takeShot(state, strikerPos, angle, speed) {
  const bodies = shotBodies(state, strikerPos);
  const meta = new Map(bodies.map((b) => [b.id, { color: b.color, kind: b.kind, radius: b.radius }]));
  const res = simulate({ bodies }, { strikerId: 'striker', angle, speed });

  const byId = new Map(bodies.map((b) => [b.id, b]));
  const pocketed = new Set(res.pocketed);
  const color = turnColor(state);
  const info = { color, opp: oppColor(color), ownPocketed: 0, oppPocketed: 0, queenPocketed: false, strikerPocketed: pocketed.has('striker') };
  for (const id of pocketed) {
    if (id === 'striker') continue;
    const c = byId.get(id).color;
    if (c === 'queen') info.queenPocketed = true;
    else if (c === color) info.ownPocketed += 1;
    else info.oppPocketed += 1;
  }

  // remove pocketed pieces; update survivors to their settled positions
  state.pieces = state.pieces
    .filter((p) => !pocketed.has(p.id))
    .map((p) => ({ ...p, pos: { x: byId.get(p.id).pos.x, y: byId.get(p.id).pos.y } }));

  const outcome = applyOutcome(state, info);
  return { timeline: res.timeline, meta, outcome };
}
