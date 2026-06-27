import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smallestPositiveQuadratic, firstRoot } from '../src/roots.js';

test('quadratic: smallest positive root', () => {
  // (t-2)(t-5) = t^2 - 7t + 10
  assert.equal(smallestPositiveQuadratic(1, -7, 10), 2);
});

test('quadratic: both roots negative -> Infinity', () => {
  // (t+2)(t+5) = t^2 + 7t + 10
  assert.equal(smallestPositiveQuadratic(1, 7, 10), Infinity);
});

test('quadratic: no real roots -> Infinity', () => {
  assert.equal(smallestPositiveQuadratic(1, 0, 1), Infinity);
});

test('firstRoot brackets the first crossing', () => {
  // f > 0 before t=1, < 0 in (1,2), > 0 after — first crossing at t=1
  const f = (t) => (t - 1) * (t - 2);
  assert.ok(Math.abs(firstRoot(f, 5) - 1) < 1e-6);
});

test('firstRoot returns Infinity when never crossing', () => {
  assert.equal(firstRoot((t) => t * t + 1, 5), Infinity);
});
