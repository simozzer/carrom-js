// collisions.js — impulse resolution.
//
// Phase 1: linear collision along the contact normal with restitution e
//   (port of ResolveElasticCollision from the Delphi note). Conserves momentum;
//   conserves kinetic energy when e = 1.
// Phase 3: + tangential friction impulse at the contact -> spin transfer ("throw").
//   Enabled when muT > 0. A spinning disc (omega about the vertical axis) drags its
//   contact point, and Coulomb friction (clamped to muT*|normal impulse|) converts that
//   into a sideways kick + spin exchange. For a uniform disc, radius^2/I = 2/m, so the
//   tangential effective inverse-mass is 3*(1/m_a + 1/m_b). Free paths stay straight, so
//   the analytic event detection is unaffected — only the velocities at contact change.

import * as v from './vec2.js';

const inertiaOf = (b) => 0.5 * b.mass * b.radius * b.radius; // uniform disc

// Resolve a disc/disc collision in place. Mutates a.vel/b.vel (and, if muT>0, a.omega/b.omega).
export function resolvePair(a, b, restitution, muT = 0) {
  const n = v.normalize(v.sub(a.pos, b.pos)); // contact normal, b -> a
  const vrel = v.sub(a.vel, b.vel);
  const vn = v.dot(vrel, n);
  if (vn > 0) return; // already separating — safety

  const invA = 1 / a.mass;
  const invB = 1 / b.mass;
  const jn = (-(1 + restitution) * vn) / (invA + invB); // normal impulse magnitude
  a.vel = v.add(a.vel, v.scale(n, jn * invA));
  b.vel = v.sub(b.vel, v.scale(n, jn * invB));

  if (muT <= 0) return; // Phase 1 only

  // Tangential ("throw") impulse along t = perp(n).
  const t = v.perp(n);
  const Ia = inertiaOf(a);
  const Ib = inertiaOf(b);
  // tangential relative SURFACE velocity (linear part + spin part):
  //   u_t = (va - vb)·t - (omega_a*r_a + omega_b*r_b)
  const ut = v.dot(vrel, t) - (a.omega * a.radius + b.omega * b.radius);
  const invMt = invA + invB + (a.radius * a.radius) / Ia + (b.radius * b.radius) / Ib;
  let jt = -ut / invMt;
  const cap = muT * Math.abs(jn); // Coulomb limit
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  a.vel = v.add(a.vel, v.scale(t, jt * invA));
  b.vel = v.sub(b.vel, v.scale(t, jt * invB));
  // torque from the tangential impulse at each contact point (r = ∓radius·n):
  a.omega += (-a.radius * jt) / Ia;
  b.omega += (-b.radius * jt) / Ib;
}

// Reflect the normal velocity component off a wall, scaled by restitution.
// restThreshold zeroes a tiny rebound so a body settling against a cushion can't
// micro-bounce forever (Zeno). muT>0 adds cushion "throw": spin <-> tangential velocity.
export function resolveWall(body, axis, restitution, restThreshold = 1e-3, muT = 0) {
  const vx = body.vel.x;
  const vy = body.vel.y;

  let nvx = vx;
  let nvy = vy;
  if (axis === 'x') {
    nvx = -vx * restitution;
    if (Math.abs(nvx) < restThreshold) nvx = 0;
  } else {
    nvy = -vy * restitution;
    if (Math.abs(nvy) < restThreshold) nvy = 0;
  }
  body.vel = { x: nvx, y: nvy };

  if (muT <= 0) return; // Phase 1 only

  // Cushion throw. Inward normal n opposes the incoming normal velocity; tangent t = perp(n).
  const I = inertiaOf(body);
  const invM = 1 / body.mass;
  let nIx;
  let nIy;
  let jnMag;
  if (axis === 'x') {
    nIx = -Math.sign(vx);
    nIy = 0;
    jnMag = body.mass * Math.abs(vx) * (1 + restitution);
  } else {
    nIx = 0;
    nIy = -Math.sign(vy);
    jnMag = body.mass * Math.abs(vy) * (1 + restitution);
  }
  const tx = -nIy; // perp(n)
  const ty = nIx;
  const vt = body.vel.x * tx + body.vel.y * ty; // tangential vel (unchanged by the normal step)
  const ut = vt - body.omega * body.radius;
  const invMt = invM + (body.radius * body.radius) / I; // = 3/m for a disc
  let jt = -ut / invMt;
  const cap = muT * jnMag;
  if (jt > cap) jt = cap;
  else if (jt < -cap) jt = -cap;

  body.vel = { x: body.vel.x + jt * invM * tx, y: body.vel.y + jt * invM * ty };
  body.omega += (-body.radius * jt) / I;
}
