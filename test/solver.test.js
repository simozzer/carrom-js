import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cubicRoots, firstQuarticRoot } from '../src/roots.js';
import { Body } from '../src/body.js';
import { detectPair, detectPocket } from '../src/events.js';
import { PUCK, STRIKER, pockets } from '../src/board.js';
import * as v from '../src/vec2.js';

// --- direct root-solver checks ---------------------------------------------
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const hasRoot = (roots, x, tol = 1e-6) => roots.some((r) => close(r, x, tol));

test('cubicRoots: three real roots', () => {
  // (t+3)(t-1)(t-4) = t^3 - 2t^2 - 11t + 12
  const r = cubicRoots(1, -2, -11, 12);
  assert.equal(r.length, 3);
  for (const x of [-3, 1, 4]) assert.ok(hasRoot(r, x), `missing root ${x}: ${r}`);
});

test('cubicRoots: one real root', () => {
  // (t-2)(t^2+1) = t^3 - 2t^2 + t - 2
  const r = cubicRoots(1, -2, 1, -2).filter((x) => Number.isFinite(x));
  assert.ok(hasRoot(r, 2), `${r}`);
});

test('firstQuarticRoot: first downcrossing', () => {
  // q(t) = (t-1)(t-2)(t-3)(t-4): >0 at 0, first crossing at t=1
  const k0 = 24, k1 = -50, k2 = 35, k3 = -10, k4 = 1; // expanded
  assert.ok(close(firstQuarticRoot(k4, k3, k2, k1, k0, 0, 10), 1, 1e-6));
});

test('firstQuarticRoot: no crossing -> Infinity', () => {
  // q(t) = t^2 + 1 (as a quartic with k4=k3=0): never <= 0
  assert.equal(firstQuarticRoot(0, 0, 1, 0, 1, 0, 10), Infinity);
});

// --- cross-validation: analytic vs a fine numerical reference ---------------
function refPair(a, b) {
  const R = a.radius + b.radius;
  const dp = v.sub(a.pos, b.pos);
  if (v.len(dp) - R <= 1e-7) {
    const vn = v.dot(v.sub(a.vel, b.vel), v.normalize(dp));
    return vn < 0 ? 1e-9 : Infinity;
  }
  if (!a.moving && !b.moving) return Infinity;
  const horizon = Math.max(a.stopTime(), b.stopTime());
  if (!(horizon > 0)) return Infinity;
  const f = (t) => v.len2(v.sub(a.posAt(t), b.posAt(t))) - R * R;
  const steps = 60000;
  let prev = 0;
  for (let i = 1; i <= steps; i++) {
    const t = (horizon * i) / steps;
    if (f(t) <= 0) {
      let lo = prev;
      let hi = t;
      for (let k = 0; k < 70; k++) {
        const m = 0.5 * (lo + hi);
        if (f(m) <= 0) hi = m;
        else lo = m;
      }
      return 0.5 * (lo + hi);
    }
    prev = t;
  }
  return Infinity;
}

// deterministic PRNG
let seed = 12345;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const span = (lo, hi) => lo + (hi - lo) * rnd();

function randomBody(id) {
  const radius = rnd() < 0.3 ? STRIKER.radius : PUCK.radius;
  const moving = rnd() < 0.85;
  const ang = span(0, Math.PI * 2);
  const sp = moving ? span(0.2, 5) : 0;
  return new Body({
    id,
    kind: 'man',
    pos: v.vec(span(-0.3, 0.3), span(-0.3, 0.3)),
    vel: v.vec(Math.cos(ang) * sp, Math.sin(ang) * sp),
    radius,
    mass: PUCK.mass,
  });
}

const agree = (x, y) => {
  if (x === Infinity || y === Infinity) return x === Infinity && y === Infinity;
  return Math.abs(x - y) <= Math.max(2e-3, 0.02 * y);
};

test('analytic detectPair matches the numerical reference over random configs', () => {
  let mismatches = 0;
  for (let i = 0; i < 1500; i++) {
    const a = randomBody('a');
    const b = randomBody('b');
    if (v.len(v.sub(a.pos, b.pos)) - (a.radius + b.radius) <= 1e-7) continue; // skip initial overlap
    const got = detectPair(a, b);
    const ref = refPair(a, b);
    if (!agree(got, ref)) {
      mismatches += 1;
      if (mismatches <= 3) console.error(`pair mismatch: analytic=${got} ref=${ref}`);
    }
  }
  assert.equal(mismatches, 0);
});

test('analytic detectPocket matches the numerical reference over random configs', () => {
  const pk = pockets();
  let mismatches = 0;
  for (let i = 0; i < 1000; i++) {
    const b = randomBody('p');
    if (!b.moving) continue;
    // numerical reference: earliest pocket via fine scan
    const T = b.stopTime();
    let ref = Infinity;
    for (const pocket of pk) {
      const c = pocket.center;
      const rp = pocket.radius;
      if (v.len(v.sub(b.pos, c)) <= rp) { ref = 1e-9; break; }
      const f = (t) => v.len2(v.sub(b.posAt(t), c)) - rp * rp;
      let prev = 0;
      for (let k = 1; k <= 60000; k++) {
        const t = (T * k) / 60000;
        if (f(t) <= 0) {
          let lo = prev;
          let hi = t;
          for (let j = 0; j < 70; j++) { const m = 0.5 * (lo + hi); if (f(m) <= 0) hi = m; else lo = m; }
          ref = Math.min(ref, 0.5 * (lo + hi));
          break;
        }
        prev = t;
      }
    }
    const got = detectPocket(b, pk);
    const gotT = got ? got.time : Infinity;
    if (!agree(gotT, ref)) {
      mismatches += 1;
      if (mismatches <= 3) console.error(`pocket mismatch: analytic=${gotT} ref=${ref}`);
    }
  }
  assert.equal(mismatches, 0);
});
