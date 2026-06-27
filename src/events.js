// events.js — event detection (all closed-form / analytic).
//
// Each detector returns time-to-event (relative to now) or Infinity/null.
//   wall   — a body's per-axis motion is a quadratic in t.
//   pair   — relative motion is p0 + v0 t + 0.5 a t^2 (constant a while both move), so
//            |Δp(t)|^2 = R^2 is a quartic. Solved analytically (roots.firstQuarticRoot)
//            over the window each body is still moving — no numerical scan.
//   pocket — same quartic against a fixed pocket centre.
//
// Each body decelerates with constant acceleration a = -mu*g * dir until it stops at
// its stopTime, then freezes (matching body.posAt). A pair is solved piecewise: the
// [0, T1] window where both move (T1 = sooner stop), then [T1, T2] with the sooner one
// frozen — the engine re-detects after each event so this two-window split is exact.
//
// Simplification: pockets coexist with full cushions at the corners; the earliest of
// the wall/pocket events wins (a clean diagonal pot is captured).

import * as v from './vec2.js';
import { smallestPositiveQuadratic, firstQuarticRoot } from './roots.js';
import { FRICTION_MU, GRAVITY } from './board.js';

const DECEL = FRICTION_MU * GRAVITY;
const TIME_EPS = 1e-9;
const CONTACT_EPS = 1e-7; // metres: treat as already-touching

// Constant acceleration vector for a body during its moving phase (zero if at rest).
const accelOf = (body) => (body.moving ? v.scale(v.normalize(body.vel), -DECEL) : v.vec(0, 0));

// First contact time of relative motion Δp(t) = A + B t + C t² (|Δp| = R), within
// (lo, hi]. Coeffs of the quartic |A + B t + C t²|² - R² = 0.
function firstContact(A, B, C, R, lo, hi) {
  if (hi <= lo + TIME_EPS) return Infinity;
  const k4 = v.dot(C, C);
  const k3 = 2 * v.dot(B, C);
  const k2 = v.dot(B, B) + 2 * v.dot(A, C);
  const k1 = 2 * v.dot(A, B);
  const k0 = v.dot(A, A) - R * R;
  const t = firstQuarticRoot(k4, k3, k2, k1, k0, lo, hi);
  return t > TIME_EPS && t < Infinity ? t : Infinity;
}

// Earliest wall contact for a moving body. Returns { time, axis } or null.
// axis 'x' => reflect vel.x; axis 'y' => reflect vel.y.
export function detectWall(body, bounds) {
  if (!body.moving) return null;
  const ts = body.stopTime();
  const d = v.normalize(body.vel);
  const ax = -DECEL * d.x; // constant accel components during this phase
  const ay = -DECEL * d.y;
  const r = body.radius;

  let best = Infinity;
  let axis = null;
  const tryWall = (a, b, c, which) => {
    // a t^2 + b t + c = 0, but our quadratic helper expects a*t^2: pass 0.5*accel.
    const t = smallestPositiveQuadratic(0.5 * a, b, c, TIME_EPS);
    if (t <= ts + 1e-12 && t < best) {
      best = t;
      axis = which;
    }
  };
  tryWall(ax, body.vel.x, body.pos.x - (bounds.minX + r), 'x'); // left
  tryWall(ax, body.vel.x, body.pos.x - (bounds.maxX - r), 'x'); // right
  tryWall(ay, body.vel.y, body.pos.y - (bounds.minY + r), 'y'); // bottom
  tryWall(ay, body.vel.y, body.pos.y - (bounds.maxY - r), 'y'); // top

  return axis ? { time: best, axis } : null;
}

// Earliest contact time between two bodies, or Infinity. Analytic quartic.
export function detectPair(a, b) {
  const R = a.radius + b.radius;
  const dp = v.sub(a.pos, b.pos);

  // Already touching: an event only if approaching (re-collision guard — a just-resolved
  // pair is separating and must not be re-detected at dt~0).
  if (v.len(dp) - R <= CONTACT_EPS) {
    const vn = v.dot(v.sub(a.vel, b.vel), v.normalize(dp));
    return vn < 0 ? TIME_EPS : Infinity;
  }
  if (!a.moving && !b.moving) return Infinity;

  const Ta = a.stopTime();
  const Tb = b.stopTime();
  const accA = accelOf(a);
  const accB = accelOf(b);
  const T1 = Math.min(Ta, Tb); // sooner stop
  const T2 = Math.max(Ta, Tb);

  // Window 1: [0, T1] — both bodies still moving (constant relative acceleration).
  if (T1 > 0) {
    const t = firstContact(
      v.sub(a.pos, b.pos),
      v.sub(a.vel, b.vel),
      v.scale(v.sub(accA, accB), 0.5),
      R,
      0,
      T1,
    );
    if (t < Infinity) return t; // earliest window → first root is the global first
  }

  // Window 2: [T1, T2] — the sooner-stopping body is frozen, the other still moves.
  if (T2 > T1) {
    const aFirst = Ta <= Tb;
    const frozen = aFirst ? a : b;
    const moving = aFirst ? b : a;
    const accMoving = aFirst ? accB : accA;
    const Pf = frozen.posAt(T1); // frozen position
    return firstContact(v.sub(moving.pos, Pf), moving.vel, v.scale(accMoving, 0.5), R, T1, T2);
  }
  return Infinity;
}

// Earliest pocket capture for a moving body. Returns { time, pocketIndex } or null.
// A body is pocketed when its centre falls within a pocket's radius.
export function detectPocket(body, pocketList) {
  if (!body.moving) return null;
  const T = body.stopTime();
  const C = v.scale(accelOf(body), 0.5);

  let best = Infinity;
  let idx = -1;
  for (let p = 0; p < pocketList.length; p++) {
    const c = pocketList[p].center;
    const rp = pocketList[p].radius;
    if (v.len(v.sub(body.pos, c)) <= rp) return { time: TIME_EPS, pocketIndex: p };
    const t = firstContact(v.sub(body.pos, c), body.vel, C, rp, 0, T);
    if (t < best) {
      best = t;
      idx = p;
    }
  }
  return idx >= 0 ? { time: best, pocketIndex: idx } : null;
}
