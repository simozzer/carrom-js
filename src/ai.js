// ai.js — the computer opponent.
//
// candidateShots: ghost-ball aims (strike a target on the line through it from a pocket)
//   for every own man × pocket, ranked by geometric quality. Includes single-cushion BANK
//   shots off the far edge, so men sitting behind the striker (no legal forward direct line)
//   can still be potted by rebounding back into them.
// planShot: the best candidate by geometry alone (cheap; used as a fallback).
// chooseShot: simulation-scored selection — run a bounded look-ahead on the top
//   candidates and pick the outcome that pots without scratching. This is what makes it
//   play accurately. Bounded (candidate count + look-ahead depth) to stay snappy.
// jitterShot: random ±10% on angle or speed (kept for an optional "imperfect" mode).

import { pockets, PUCK, STRIKER, FRICTION_MU, GRAVITY, BOARD, walls } from './board.js';
import { simulate } from './simulate.js';
import { turnColor, oppColor, baselineY, strikerXLimit, shotBodies, clampForwardAngle } from './game.js';
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
  const all = out.concat(reboundCandidates(game));
  all.sort((a, b) => b.geom - a.geom);
  return all;
}

// Single-cushion bank shots off the FAR edge: fire forward, rebound off the opposite cushion,
// and come back to the ghost-ball point. This is what lets the AI pot men sitting behind it
// (near its own baseline), where no legal forward direct line exists.
//
// Geometry: within each straight leg friction only changes speed, not direction, so the path
// shape is friction-independent — only the cushion restitution e bends it (the perpendicular
// velocity flips and is scaled by e). For a horizontal far cushion at the striker-centre line
// Yw, leg 1 has slope m1 = dy/dx, and requiring the post-bounce leg to pass through the ghost
// point C = (cx, cy) gives, after folding the bounce in:
//     m1 = ((Yw - y0) + (Yw - cy)/e) / (cx - s)
// for a striker at (s, y0). We sample a few s along the baseline and keep the geometrically
// valid ones (bounce actually lands on the far cushion, return leg pushes T toward the pocket).
function reboundCandidates(game) {
  const color = turnColor(game);
  const y0 = baselineY(color);
  const lim = strikerXLimit();
  const into = -Math.sign(y0); // forward direction (+1 white, -1 black)
  const rS = STRIKER.radius;
  const rT = PUCK.radius;
  const e = BOARD.cushionRestitution;
  const w = walls();
  const Yw = into * (BOARD.size / 2 - rS); // far cushion: striker-centre y at the bounce
  const targets = game.pieces.filter((p) => p.color === color);
  const sSamples = [-lim, -lim / 2, 0, lim / 2, lim];

  const out = [];
  for (const T of targets) {
    for (const pk of pockets()) {
      const toPocket = v.sub(pk.center, T.pos);
      const dPocket = v.len(toPocket);
      if (dPocket < 1e-6) continue;
      const dir = v.scale(toPocket, 1 / dPocket); // direction T must travel to the pocket
      const C = v.sub(T.pos, v.scale(dir, rS + rT)); // ghost-ball striker-centre at contact
      if ((Yw - C.y) * into <= 1e-4) continue; // C must sit short of the far cushion to bank back

      for (const s of sSamples) {
        const denom = C.x - s;
        if (Math.abs(denom) < 1e-4) continue;
        const m1 = ((Yw - y0) + (Yw - C.y) / e) / denom; // leg-1 slope dy/dx
        if (Math.abs(m1) < 1e-6) continue;
        const d1 = v.normalize({ x: into / m1, y: into }); // leg-1 dir, forward (dy sign = into)
        const xw = s + (Yw - y0) / m1; // bounce x on the far cushion
        if (xw < w.minX + rS || xw > w.maxX - rS) continue; // must hit the far cushion, not a side

        const d2 = v.normalize({ x: d1.x, y: -e * d1.y }); // post-bounce direction
        const align = v.dot(d2, dir); // approach should push T toward the pocket
        if (align <= 0) continue;

        const leg1 = Math.hypot(xw - s, Yw - y0);
        const leg2 = Math.hypot(C.x - xw, C.y - Yw);
        const pathLen = leg1 + leg2 + dPocket;
        // the cushion bleeds energy, so banks want near-max power; the grid samples around it
        const speed = Math.max(4.0, Math.min(6.0, Math.sqrt(2 * DECEL * pathLen) * 2.4));
        // bank penalty (-0.6) keeps direct shots preferred when both are available
        out.push({ strikerPos: v.vec(s, y0), angle: Math.atan2(d1.y, d1.x), speed, geom: align - 0.3 * pathLen - 0.6 });
      }
    }
  }
  return out;
}

export function planShot(game) {
  const cands = candidateShots(game);
  if (cands.length) return { strikerPos: cands[0].strikerPos, angle: cands[0].angle, speed: cands[0].speed };
  const color = turnColor(game);
  const y0 = baselineY(color);
  const targets = game.pieces.filter((p) => p.color === color);
  const tgt = targets[0] ? targets[0].pos : v.vec(0, 0);
  const angle = clampForwardAngle(color, Math.atan2(tgt.y - y0, tgt.x)); // never fire backward
  return { strikerPos: v.vec(0, y0), angle, speed: 3.5, spin: 0 };
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

// Simulate one shot to rest and score the outcome from `color`'s perspective.
function simScore(game, color, strikerPos, angle, speed, maxEvents, spin = 0) {
  const bodies = shotBodies(game, strikerPos);
  const res = simulate({ bodies }, { strikerId: 'striker', angle, speed, spin }, { maxEvents, timeline: false, spin: spin !== 0 });
  const byId = new Map(bodies.map((b) => [b.id, b]));
  return scoreResult(res, byId, color);
}

// Simulation-scored shot: take the top candidate lines, and around each one sample a small
// grid of power scales × angle nudges, simulate every variant to rest, and keep the best
// outcome. The grid matters because the ghost-ball geometry is only approximate — sampling
// nearby power/angle finds the variant that actually pots cleanly without scratching.
//
// Skipping the replay timeline (timeline:false) makes each simulation cheap, so the search
// runs deep (full settle by default) and wide. Knobs:
//   maxCandidates — how many ghost-ball lines to evaluate (breadth)
//   maxEvents     — collision cap per simulation; omit/undefined = run to rest (depth)
//   powerScales   — power multipliers tried per candidate
//   angleOffsets  — angle nudges (radians) tried per candidate
//   spins         — strike-offset spins (−1..1) tried per candidate; default [0] = no spin.
//                   Off-centre spin only helps situationally, so spin=0 is in the set and
//                   wins unless a spun variant scores strictly better.
//   robust        — { anglePct, speedPct, keep? }: re-rank the top `keep` lines by their
//                   EXPECTED score over the execution-error box (the same ±pct wobble that
//                   applyError will add), so a line that only pots on a knife-edge — and
//                   self-pockets when the real shot wobbles — is downranked in favour of one
//                   that stays safe. Pass the chosen difficulty's pcts here.
//   slice         — { workers, index }: evaluate only candidates where index ≡ candidate#
//                   (mod workers). Lets a worker pool split the search across CPU cores; each
//                   returns its best (with `.score`) and the caller keeps the global max.
//                   Returns null when this slice has no candidates. The returned shot always
//                   carries a `.score` (nominal, or expected when robust) for that merge.
export function chooseShot(
  game,
  { maxCandidates = 10, maxEvents, powerScales = [0.8, 1.0, 1.15], angleOffsets = [-0.01, 0, 0.01], spins = [0], robust = null, slice = null } = {},
) {
  const color = turnColor(game);
  const base = candidateShots(game).slice(0, maxCandidates);
  // a worker pool partitions the candidate list; each worker scores only its share
  const list = slice ? base.filter((_, i) => i % slice.workers === slice.index) : base;
  if (slice && list.length === 0) return null; // nothing for this worker to do

  // Pass 1: nominal score of every power × angle × spin variant of every candidate line.
  const scored = [];
  for (const c of list) {
    for (const ps of powerScales) {
      const speed = Math.max(2.0, Math.min(6.0, c.speed * ps)); // keep within the legal power band
      for (const ao of angleOffsets) {
        const angle = clampForwardAngle(color, c.angle + ao);
        for (const spin of spins) {
          const score = simScore(game, color, c.strikerPos, angle, speed, maxEvents, spin) + c.geom; // geom breaks ties
          scored.push({ strikerPos: c.strikerPos, angle, speed, spin, score });
        }
      }
    }
  }
  if (!scored.length) return slice ? null : planShot(game);
  scored.sort((a, b) => b.score - a.score);

  // Pass 2 (optional): among the best nominal lines, pick the one whose EXPECTED outcome over
  // its own ±error box is best. Averaging in the foul-penalised perturbations sinks any line
  // that self-pockets under a plausible wobble, even if its dead-centre shot pots cleanly.
  const ap = robust?.anglePct ?? 0;
  const sp = robust?.speedPct ?? 0;
  if (!robust || (ap === 0 && sp === 0)) return scored[0];

  const keep = Math.min(robust.keep ?? 8, scored.length);
  let best = null;
  for (const cand of scored.slice(0, keep)) {
    let sum = cand.score; // include the nominal shot...
    let n = 1;
    for (const da of [-1, 0, 1]) {
      for (const ds of [-1, 0, 1]) {
        if (da === 0 && ds === 0) continue; // ...plus the 8 surrounding error-box samples
        const angle = clampForwardAngle(color, cand.angle * (1 + da * ap));
        const speed = Math.max(2.0, Math.min(6.0, cand.speed * (1 + ds * sp)));
        sum += simScore(game, color, cand.strikerPos, angle, speed, maxEvents, cand.spin);
        n += 1;
      }
    }
    const expected = sum / n;
    // carry the expected value as `.score` so a worker pool can merge robust results too
    if (!best || expected > best.score) best = { ...cand, score: expected };
  }
  return best;
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
