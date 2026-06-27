// ai.js — the computer opponent.
//
// candidateShots: ghost-ball aims (strike a target on the line through it from a pocket)
//   for every own man × pocket, ranked by geometric quality.
// planShot: the best candidate by geometry alone (cheap; used as a fallback).
// chooseShot: simulation-scored selection — run a bounded look-ahead on the top
//   candidates and pick the outcome that pots without scratching. This is what makes it
//   play accurately. Bounded (candidate count + look-ahead depth) to stay snappy.
// jitterShot: random ±10% on angle or speed (kept for an optional "imperfect" mode).

import { pockets, PUCK, STRIKER, FRICTION_MU, GRAVITY } from './board.js';
import { simulate } from './simulate.js';
import { turnColor, oppColor, baselineY, strikerXLimit, shotBodies } from './game.js';
import * as v from './vec2.js';

const DECEL = FRICTION_MU * GRAVITY;

// All viable ghost-ball candidates, best geometry first.
function candidateShots(game) {
  const color = turnColor(game);
  const y0 = baselineY(color);
  const lim = strikerXLimit();
  const into = -Math.sign(y0);
  const targets = game.pieces.filter((p) => p.color === color);
  const rT = PUCK.radius;

  const out = [];
  for (const T of targets) {
    for (const pk of pockets()) {
      const toPocket = v.sub(pk.center, T.pos);
      const dPocket = v.len(toPocket);
      if (dPocket < 1e-6) continue;
      const dir = v.scale(toPocket, 1 / dPocket);
      const C = v.sub(T.pos, v.scale(dir, STRIKER.radius + rT));

      let S = null;
      if (Math.abs(dir.y) > 1e-3) {
        const L = (C.y - y0) / dir.y;
        const sx = C.x - dir.x * L;
        if (L > 0 && Math.abs(sx) <= lim) S = v.vec(sx, y0);
      }
      if (!S) S = v.vec(Math.max(-lim, Math.min(lim, C.x)), y0);

      const sc = v.sub(C, S);
      const scLen = v.len(sc);
      if (scLen < 1e-6) continue;
      if (Math.sign(sc.y) !== into) continue;
      const approach = v.scale(sc, 1 / scLen);
      const align = v.dot(approach, dir);
      if (align <= 0) continue;

      const pathLen = scLen + dPocket;
      const speed = Math.max(2.5, Math.min(6.0, Math.sqrt(2 * DECEL * pathLen) * 1.6));
      out.push({ strikerPos: S, angle: Math.atan2(sc.y, sc.x), speed, geom: align - 0.3 * pathLen });
    }
  }
  out.sort((a, b) => b.geom - a.geom);
  return out;
}

export function planShot(game) {
  const cands = candidateShots(game);
  if (cands.length) return { strikerPos: cands[0].strikerPos, angle: cands[0].angle, speed: cands[0].speed };
  const color = turnColor(game);
  const y0 = baselineY(color);
  const targets = game.pieces.filter((p) => p.color === color);
  const tgt = targets[0] ? targets[0].pos : v.vec(0, 0);
  return { strikerPos: v.vec(0, y0), angle: Math.atan2(tgt.y - y0, tgt.x), speed: 3.5 };
}

// Score a simulated shot result from `color`'s perspective.
function scoreResult(res, byId, color) {
  let own = 0;
  let opp = 0;
  let queen = false;
  const foul = res.pocketed.includes('striker');
  for (const id of res.pocketed) {
    if (id === 'striker') continue;
    const col = byId.get(id).color;
    if (col === 'queen') queen = true;
    else if (col === color) own += 1;
    else opp += 1;
  }
  return own * 100 + (queen ? 70 : 0) - opp * 60 - (foul ? 500 : 0);
}

// Simulation-scored shot: try the top candidates (each at its planned power and a softer
// variant), simulate a bounded look-ahead, and keep the best outcome. opts.maxEvents caps
// the look-ahead depth (snappy); opts.maxCandidates caps how many lines are evaluated.
export function chooseShot(game, { maxCandidates = 6, maxEvents } = {}) {
  const color = turnColor(game);
  const base = candidateShots(game).slice(0, maxCandidates);
  const cands = [];
  for (const c of base) {
    cands.push(c);
    cands.push({ ...c, speed: Math.max(2.0, c.speed * 0.8) }); // softer variant — avoid scratches
  }

  let best = null;
  for (const c of cands) {
    const bodies = shotBodies(game, c.strikerPos);
    const res = simulate({ bodies }, { strikerId: 'striker', angle: c.angle, speed: c.speed }, { maxEvents });
    const byId = new Map(bodies.map((b) => [b.id, b]));
    const score = scoreResult(res, byId, color) + c.geom; // geom breaks ties between equal outcomes
    if (!best || score > best.score) best = { strikerPos: c.strikerPos, angle: c.angle, speed: c.speed, score };
  }
  return best ?? planShot(game);
}

// Execution error applied to a chosen shot: independent random ±anglePct on the angle
// and ±speedPct on the power. Defaults: ±0.5% angle, ±5% power. Larger = easier opponent.
export function applyError(shot, { anglePct = 0.005, speedPct = 0.05 } = {}, rng = Math.random) {
  const af = 1 + (rng() * 2 - 1) * anglePct;
  const sf = 1 + (rng() * 2 - 1) * speedPct;
  return { ...shot, angle: shot.angle * af, speed: shot.speed * sf };
}

// Apply a random ±10% to either the angle or the speed (legacy single-axis jitter).
export function jitterShot(shot, rng = Math.random) {
  const pickAngle = rng() < 0.5;
  const factor = 1 + (rng() * 2 - 1) * 0.1;
  return pickAngle ? { ...shot, angle: shot.angle * factor } : { ...shot, speed: shot.speed * factor };
}
