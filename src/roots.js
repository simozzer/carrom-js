// roots.js — root finding for collision-time solves.
//
// Two tools:
//   smallestPositiveQuadratic — exact, for straight-line (Phase 1) wall/pair times.
//   firstRoot — bracketed numerical first-crossing, for pockets (Phase 2) and the
//               curved spinning trajectories (Phase 3) where no closed form exists.

const EPS = 1e-12;

// Smallest root > minT of  a t^2 + b t + c = 0, or Infinity if none.
export function smallestPositiveQuadratic(a, b, c, minT = EPS) {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return Infinity;
    const t = -c / b;
    return t > minT ? t : Infinity;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return Infinity;
  const s = Math.sqrt(disc);
  const t1 = (-b - s) / (2 * a);
  const t2 = (-b + s) / (2 * a);
  let best = Infinity;
  if (t1 > minT) best = t1;
  if (t2 > minT && t2 < best) best = t2;
  return best;
}

// Real roots of a t^2 + b t + c (any order, may return 0/1/2 roots).
function quadReal(a, b, c) {
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b - s) / (2 * a), (-b + s) / (2 * a)];
}

// Real roots of a cubic a t^3 + b t^2 + c t + d (Cardano, trig form for 3 real roots).
export function cubicRoots(a, b, c, d) {
  if (Math.abs(a) < EPS) return quadReal(b, c, d);
  const p = b / a;
  const q = c / a;
  const r = d / a;
  // depress: t = x - p/3  ->  x^3 + P x + Q
  const P = q - (p * p) / 3;
  const Q = (2 * p * p * p) / 27 - (p * q) / 3 + r;
  const shift = -p / 3;
  const disc = (Q * Q) / 4 + (P * P * P) / 27;
  if (disc > EPS) {
    const s = Math.sqrt(disc);
    return [Math.cbrt(-Q / 2 + s) + Math.cbrt(-Q / 2 - s) + shift];
  }
  if (disc < -EPS) {
    // three distinct real roots
    const m = 2 * Math.sqrt(-P / 3);
    let arg = (3 * Q) / (P * m);
    arg = Math.max(-1, Math.min(1, arg)); // clamp for acos safety
    const th = Math.acos(arg) / 3;
    return [0, 1, 2].map((k) => m * Math.cos(th - (2 * Math.PI * k) / 3) + shift);
  }
  // disc ~ 0: repeated roots
  const u = Math.cbrt(-Q / 2);
  return [2 * u + shift, -u + shift];
}

// First t in (lo, hi] where the quartic q(t)=k4 t^4+..+k0 crosses to <= 0, assuming
// q(lo) > 0. Exact: brackets via the quartic's critical points (cubic q'=0), then
// bisects the first monotonic segment that changes sign. Infinity if it never crosses.
export function firstQuarticRoot(k4, k3, k2, k1, k0, lo, hi, tol = 1e-10) {
  const q = (t) => (((k4 * t + k3) * t + k2) * t + k1) * t + k0;
  if (hi <= lo) return Infinity;
  if (q(lo) <= 0) return lo;
  // critical points: q'(t) = 4k4 t^3 + 3k3 t^2 + 2k2 t + k1
  const crit = cubicRoots(4 * k4, 3 * k3, 2 * k2, k1)
    .filter((t) => t > lo && t < hi)
    .sort((x, y) => x - y);
  let a = lo;
  for (const bp of [...crit, hi]) {
    if (q(bp) <= 0) {
      let x0 = a;
      let x1 = bp;
      while (x1 - x0 > tol) {
        const m = 0.5 * (x0 + x1);
        if (q(m) <= 0) x1 = m;
        else x0 = m;
      }
      return 0.5 * (x0 + x1);
    }
    a = bp;
  }
  return Infinity;
}

// First t in (0, horizon] where f crosses from >0 to <=0, refined by bisection.
// Scans `steps` sub-intervals to bracket the FIRST sign change — the delicate part
// of event-driven detection: a step too coarse can skip a brief approach.
export function firstRoot(f, horizon, steps = 256, tol = 1e-9) {
  let fPrev = f(0);
  if (fPrev <= 0) return 0; // already in contact
  const dt = horizon / steps;
  let tPrev = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i * dt;
    const ft = f(t);
    if (ft <= 0) {
      let lo = tPrev;
      let hi = t;
      while (hi - lo > tol) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return 0.5 * (lo + hi);
    }
    tPrev = t;
    fPrev = ft;
  }
  return Infinity;
}
