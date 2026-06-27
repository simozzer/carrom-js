import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body } from '../src/body.js';
import { resolvePair } from '../src/collisions.js';
import * as v from '../src/vec2.js';

// Two bodies positioned exactly in contact along x, so the normal is (1,0)/(-1,0).
function contactPair(velA, velB, mA = 1, mB = 1, r = 0.5) {
  const a = new Body({ id: 'a', kind: 'man', pos: v.vec(-r, 0), vel: velA, radius: r, mass: mA });
  const b = new Body({ id: 'b', kind: 'man', pos: v.vec(r, 0), vel: velB, radius: r, mass: mB });
  return [a, b];
}

const momentum = (a, b) => v.add(v.scale(a.vel, a.mass), v.scale(b.vel, b.mass));
const kinetic = (a, b) =>
  0.5 * a.mass * v.len2(a.vel) + 0.5 * b.mass * v.len2(b.vel);

test('elastic (e=1) conserves momentum and kinetic energy', () => {
  const [a, b] = contactPair(v.vec(2, 0), v.vec(-1, 0), 3, 5);
  const p0 = momentum(a, b);
  const k0 = kinetic(a, b);
  resolvePair(a, b, 1);
  const p1 = momentum(a, b);
  assert.ok(Math.abs(p1.x - p0.x) < 1e-12 && Math.abs(p1.y - p0.y) < 1e-12);
  assert.ok(Math.abs(kinetic(a, b) - k0) < 1e-12);
});

test('elastic equal masses exchange velocity (head-on)', () => {
  const [a, b] = contactPair(v.vec(1, 0), v.vec(-1, 0));
  resolvePair(a, b, 1);
  assert.ok(Math.abs(a.vel.x - -1) < 1e-12);
  assert.ok(Math.abs(b.vel.x - 1) < 1e-12);
});

test('perfectly inelastic (e=0) leaves no normal relative velocity', () => {
  const [a, b] = contactPair(v.vec(2, 0), v.vec(-1, 0), 3, 5);
  resolvePair(a, b, 0);
  const n = v.vec(-1, 0); // a - b normalized
  const vn = v.dot(v.sub(a.vel, b.vel), n);
  assert.ok(Math.abs(vn) < 1e-12);
});

test('momentum conserved for any restitution', () => {
  const [a, b] = contactPair(v.vec(1.5, 0), v.vec(-0.5, 0), 2, 7);
  const p0 = momentum(a, b);
  resolvePair(a, b, 0.6);
  const p1 = momentum(a, b);
  assert.ok(Math.abs(p1.x - p0.x) < 1e-12 && Math.abs(p1.y - p0.y) < 1e-12);
});
