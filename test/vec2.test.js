import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/vec2.js';

test('add / sub', () => {
  assert.deepEqual(v.add(v.vec(1, 2), v.vec(3, 4)), { x: 4, y: 6 });
  assert.deepEqual(v.sub(v.vec(3, 4), v.vec(1, 2)), { x: 2, y: 2 });
});

test('dot and length', () => {
  assert.equal(v.dot(v.vec(1, 0), v.vec(0, 1)), 0);
  assert.equal(v.len(v.vec(3, 4)), 5);
});

test('normalize returns a unit vector', () => {
  const n = v.normalize(v.vec(3, 4));
  assert.ok(Math.abs(v.len(n) - 1) < 1e-12);
});

test('normalize of zero is zero (no NaN)', () => {
  assert.deepEqual(v.normalize(v.vec(0, 0)), { x: 0, y: 0 });
});

test('fromAngle', () => {
  const a = v.fromAngle(0, 2);
  assert.ok(Math.abs(a.x - 2) < 1e-12 && Math.abs(a.y) < 1e-12);
});
