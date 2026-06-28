import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardSign, isForwardAngle, clampForwardAngle, FORWARD_MIN_DEG } from '../src/game.js';

const minSin = Math.sin((FORWARD_MIN_DEG * Math.PI) / 180);

test('forwardSign: White fires +y, Black fires -y', () => {
  assert.equal(forwardSign('white'), 1);
  assert.equal(forwardSign('black'), -1);
});

test('isForwardAngle accepts forward, rejects horizontal and backward', () => {
  // White: forward is +y (sin > 0)
  assert.ok(isForwardAngle('white', Math.PI / 2), 'straight up is forward');
  assert.ok(isForwardAngle('white', Math.PI / 2 - 0.4), 'forward-right is forward');
  assert.ok(!isForwardAngle('white', 0), 'horizontal-right rejected');
  assert.ok(!isForwardAngle('white', Math.PI), 'horizontal-left rejected');
  assert.ok(!isForwardAngle('white', -Math.PI / 2), 'straight down rejected');
  // Black mirrors (forward is -y)
  assert.ok(isForwardAngle('black', -Math.PI / 2), 'straight down is forward for black');
  assert.ok(!isForwardAngle('black', Math.PI / 2), 'up rejected for black');
});

test('clampForwardAngle leaves an already-forward angle unchanged', () => {
  const a = Math.PI / 2 - 0.3;
  assert.ok(isForwardAngle('white', a));
  assert.ok(Math.abs(clampForwardAngle('white', a) - a) < 1e-12);
});

test('clampForwardAngle pushes a backward/sideways aim to the forward limit on the same side', () => {
  // White aiming down-right (cos>0, sin<0) → forward-right at the minimum lean
  const c = clampForwardAngle('white', -0.5);
  assert.ok(isForwardAngle('white', c), 'result is forward');
  assert.ok(Math.cos(c) > 0, 'kept on the right (cos>0)');
  assert.ok(Math.sin(c) >= minSin - 1e-9 && Math.sin(c) <= minSin + 1e-9, 'sits exactly at the forward limit');

  // aiming down-left (cos<0) → forward-left
  const cl = clampForwardAngle('white', Math.PI + 0.5);
  assert.ok(isForwardAngle('white', cl) && Math.cos(cl) < 0, 'kept on the left');
});

test('clamping is mirror-symmetric between White and Black', () => {
  const w = clampForwardAngle('white', 0); // horizontal-right
  const b = clampForwardAngle('black', 0);
  assert.ok(Math.abs(w + b) < 1e-9, 'White +margin, Black -margin');
});
