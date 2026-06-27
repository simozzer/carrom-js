// collisions.js — impulse resolution.
//
// Phase 1: linear collision along the contact normal with restitution e
//   (port of ResolveElasticCollision from the Delphi note). Conserves momentum;
//   conserves kinetic energy when e = 1.
// Phase 3: + tangential friction impulse at the contact -> spin transfer.

import * as v from './vec2.js';

// Resolve a disc/disc collision in place. Mutates a.vel and b.vel.
export function resolvePair(a, b, restitution) {
  const n = v.normalize(v.sub(a.pos, b.pos)); // contact normal, j -> i
  const vrel = v.sub(a.vel, b.vel);
  const vn = v.dot(vrel, n);
  if (vn > 0) return; // already separating — safety

  const jimp = (-(1 + restitution) * vn) / (1 / a.mass + 1 / b.mass);
  a.vel = v.add(a.vel, v.scale(n, jimp / a.mass));
  b.vel = v.sub(b.vel, v.scale(n, jimp / b.mass));
}

// Reflect the normal velocity component off a wall, scaled by restitution.
// restThreshold zeroes a tiny rebound so a body settling against a cushion can't
// micro-bounce forever (Zeno).
export function resolveWall(body, axis, restitution, restThreshold = 1e-3) {
  if (axis === 'x') {
    let nx = -body.vel.x * restitution;
    if (Math.abs(nx) < restThreshold) nx = 0;
    body.vel = { x: nx, y: body.vel.y };
  } else {
    let ny = -body.vel.y * restitution;
    if (Math.abs(ny) < restThreshold) ny = 0;
    body.vel = { x: body.vel.x, y: ny };
  }
}
