// engine.js — the event-driven loop.
//
// Loop:
//   1. Detect ALL events from the current state (O(N^2) recompute — fine for N~20).
//   2. Pop the earliest (tie-break: time, then kind, then indices — determinism).
//   3. Advance every active body to that time along its phase trajectory, clamping any
//      that come to rest before then (no explicit 'stop' event — posAt/velAt clamp).
//   4. Resolve the event (pair impulse / wall reflect / pocket capture).
//   5. Repeat until no body is moving (or a MAX_EVENTS safety cap).
//
// Emits a timeline of post-event snapshots (ending at rest) for replay by interpolation.

import * as v from './vec2.js';
import { detectWall, detectPair, detectPocket } from './events.js';
import { resolvePair, resolveWall } from './collisions.js';
import { walls, pockets, PUCK_RESTITUTION, BOARD, FRICTION_MU, GRAVITY, PUCK_FRICTION_T, CUSHION_FRICTION_T } from './board.js';

const MAX_EVENTS = 100000;
const DECEL = FRICTION_MU * GRAVITY;
// Angular friction deceleration of a uniform disc spinning on the board: torque ≈ (2/3)μmgR,
// so dω/dt ≈ (4/3)μg/R. Used only when spin is enabled.
const SPIN_DECEL_K = (4 / 3) * DECEL;

const snap = (bodies, t, kind, intensity = 0) => ({
  t,
  kind, // 'start' | 'pair' | 'wall' | 'pocket' | 'end' — what produced this snapshot
  intensity, // impact speed (m/s) that produced this event — drives collision sound volume
  bodies: bodies.map((b) => ({
    id: b.id,
    pos: { x: b.pos.x, y: b.pos.y },
    vel: { x: b.vel.x, y: b.vel.y },
    pocketed: b.pocketed,
  })),
});

// Move all active bodies forward by dt, stopping any whose phase ends within dt.
// Spin (when present) decays under angular board friction, independent of translation.
function advance(bodies, dt) {
  if (dt <= 0) return;
  for (const b of bodies) {
    if (b.pocketed) continue;
    if (b.omega) {
      const dw = (SPIN_DECEL_K / b.radius) * dt;
      b.omega = Math.abs(b.omega) <= dw ? 0 : b.omega - Math.sign(b.omega) * dw;
    }
    if (!b.moving) continue;
    const stopped = dt >= b.stopTime();
    b.pos = b.posAt(dt);
    b.vel = stopped ? v.vec(0, 0) : b.velAt(dt);
  }
}

// pocket capture beats a cushion bounce at a tie; pair last.
const KIND_RANK = { pocket: 0, wall: 1, pair: 2 };

// opts.maxEvents caps how many collision events to resolve (look-ahead preview);
// defaults to the full safety cap (run to rest).
export function runEngine(layout, shot, opts = {}) {
  const cap = opts.maxEvents ?? MAX_EVENTS;
  // Building a full replay timeline costs a deep body-copy per event. Callers that only
  // need the final outcome (the AI's look-ahead) pass timeline:false to skip it entirely.
  const wantTimeline = opts.timeline !== false;
  // Phase 3 spin/throw is opt-in. When off, the friction coefficients are 0 and the resolvers
  // behave exactly as Phase 1 (byte-identical), so existing behaviour is unchanged.
  const spin = opts.spin === true;
  const muPair = spin ? PUCK_FRICTION_T : 0;
  const muWall = spin ? CUSHION_FRICTION_T : 0;
  const bodies = layout.bodies;
  if (shot) {
    const striker = bodies.find((b) => b.id === shot.strikerId);
    if (!striker) throw new Error(`shot.strikerId ${shot.strikerId} not found`);
    striker.vel = v.fromAngle(shot.angle, shot.speed);
    // Off-centre strike: a flick offset by (shot.spin · radius) from centre imparts spin
    // ω = strike-moment / I = (offset · m·v) / (½ m r²) = 2·spin·speed / radius.
    if (spin && shot.spin) striker.omega = (2 * shot.spin * shot.speed) / striker.radius;
  }

  const bounds = walls();
  const pocketList = pockets();
  let t = 0;
  const timeline = wantTimeline ? [snap(bodies, 0, 'start')] : [];
  let count = 0;

  while (count < cap) {
    const horizon = bodies.reduce(
      (m, b) => (!b.pocketed && b.moving ? Math.max(m, b.stopTime()) : m),
      0,
    );
    if (horizon <= 0) break; // everything at rest or pocketed

    let next = null;
    const consider = (ev) => {
      if (!next) {
        next = ev;
        return;
      }
      if (ev.time < next.time - 1e-12) {
        next = ev;
      } else if (ev.time <= next.time + 1e-12) {
        const a = [KIND_RANK[ev.kind], ev.i, ev.j ?? -1];
        const b = [KIND_RANK[next.kind], next.i, next.j ?? -1];
        if (a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])))) {
          next = ev;
        }
      }
    };

    for (let i = 0; i < bodies.length; i++) {
      if (bodies[i].pocketed) continue;
      const w = detectWall(bodies[i], bounds);
      if (w) consider({ time: t + w.time, kind: 'wall', i, axis: w.axis });
      const pk = detectPocket(bodies[i], pocketList);
      if (pk) consider({ time: t + pk.time, kind: 'pocket', i, pocketIndex: pk.pocketIndex });
      for (let j = i + 1; j < bodies.length; j++) {
        if (bodies[j].pocketed) continue;
        const tp = detectPair(bodies[i], bodies[j]);
        if (tp < Infinity) consider({ time: t + tp, kind: 'pair', i, j });
      }
    }

    if (!next) {
      advance(bodies, horizon); // coast everything to rest
      t += horizon;
      if (wantTimeline) timeline.push(snap(bodies, t, 'end'));
      break;
    }

    advance(bodies, Math.max(0, next.time - t));
    t = next.time;

    // Impact speed (m/s) just before resolving — how "hard" the contact is; drives sound volume.
    // Only needed for the replay timeline, so skip it on the AI's timeline:false look-aheads.
    let intensity = 0;
    if (next.kind === 'wall') {
      const b = bodies[next.i];
      if (wantTimeline) intensity = Math.abs(next.axis === 'x' ? b.vel.x : b.vel.y); // incoming normal speed
      resolveWall(b, next.axis, BOARD.cushionRestitution, 1e-3, muWall);
    } else if (next.kind === 'pocket') {
      const b = bodies[next.i];
      b.pocketed = true;
      b.vel = v.vec(0, 0);
      b.pocket = next.pocketIndex;
    } else {
      const a = bodies[next.i];
      const b = bodies[next.j];
      if (wantTimeline) {
        const n = v.normalize(v.sub(a.pos, b.pos));
        intensity = Math.abs(v.dot(v.sub(a.vel, b.vel), n)); // closing speed along the contact normal
      }
      resolvePair(a, b, PUCK_RESTITUTION, muPair);
    }

    if (wantTimeline) timeline.push(snap(bodies, t, next.kind, intensity));
    count += 1;
  }

  return {
    bodies,
    timeline,
    pocketed: bodies.filter((b) => b.pocketed).map((b) => b.id),
    settled: bodies.every((b) => b.pocketed || !b.moving),
    events: count,
    hitCap: count >= MAX_EVENTS,
  };
}
