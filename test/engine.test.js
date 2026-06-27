import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body } from '../src/body.js';
import { simulate } from '../src/simulate.js';
import { FRICTION_MU, GRAVITY, PUCK, walls } from '../src/board.js';
import * as v from '../src/vec2.js';

const DECEL = FRICTION_MU * GRAVITY;
const man = (id, pos, vel = v.vec(0, 0)) =>
  new Body({ id, kind: 'man', pos, vel, radius: PUCK.radius, mass: PUCK.mass });

// A lone puck coasts to rest at the analytic stopping distance d = v0^2 / (2a).
test('lone puck stops at the predicted distance', () => {
  const v0 = 0.5;
  const expected = (v0 * v0) / (2 * DECEL);
  const a = man('a', v.vec(0, 0), v.vec(v0, 0));
  const r = simulate({ bodies: [a] });
  assert.ok(r.settled);
  assert.ok(Math.abs(a.pos.x - expected) < 1e-3, `x=${a.pos.x} expected ${expected}`);
  assert.ok(Math.abs(a.pos.y) < 1e-9);
});

// Symmetric head-on collision => mirror-image final positions, both at rest.
test('symmetric head-on collision yields mirrored rest positions', () => {
  const a = man('a', v.vec(-0.1, 0), v.vec(0.6, 0));
  const b = man('b', v.vec(0.1, 0), v.vec(-0.6, 0));
  const r = simulate({ bodies: [a, b] });
  assert.ok(r.settled);
  assert.ok(a.pos.x < 0 && b.pos.x > 0, 'they should rebound past each other');
  assert.ok(Math.abs(a.pos.x + b.pos.x) < 1e-3, `not mirrored: ${a.pos.x} ${b.pos.x}`);
  assert.ok(Math.abs(a.pos.y) < 1e-9 && Math.abs(b.pos.y) < 1e-9);
});

// A struck puck transfers motion to a resting one (Newton's-cradle-ish, equal mass).
test('moving puck stops dead and transfers motion to a resting puck', () => {
  const a = man('a', v.vec(-0.1, 0), v.vec(0.8, 0));
  const b = man('b', v.vec(0, 0)); // at rest, dead ahead
  const r = simulate({ bodies: [a, b] });
  assert.ok(r.settled);
  // a should end up behind where b started; b should be pushed forward.
  assert.ok(a.pos.x < b.pos.x, `a (${a.pos.x}) should trail b (${b.pos.x})`);
  assert.ok(b.pos.x > 0, 'b should have moved forward');
});

// No body may ever come to rest outside the cushions.
test('no body escapes the board', () => {
  const w = walls();
  const bodies = [
    man('a', v.vec(0, 0), v.fromAngle(0.7, 3.0)),
    man('b', v.vec(0.05, -0.05), v.fromAngle(2.1, 2.0)),
    man('c', v.vec(-0.08, 0.06), v.fromAngle(-1.2, 2.5)),
  ];
  const r = simulate({ bodies });
  assert.ok(r.settled && !r.hitCap, `settled=${r.settled} hitCap=${r.hitCap}`);
  for (const b of bodies) {
    assert.ok(b.pos.x >= w.minX + b.radius - 1e-6 && b.pos.x <= w.maxX - b.radius + 1e-6);
    assert.ok(b.pos.y >= w.minY + b.radius - 1e-6 && b.pos.y <= w.maxY - b.radius + 1e-6);
  }
});

// maxEvents caps the look-ahead (for the aim-prediction preview).
test('maxEvents stops the simulation after the given number of collisions', () => {
  const bodies = [
    man('a', v.vec(-0.1, 0), v.fromAngle(0, 5)),
    man('b', v.vec(0.0, 0)),
    man('c', v.vec(0.06, 0.02)),
    man('d', v.vec(0.12, -0.02)),
  ];
  const r = simulate({ bodies }, null, { maxEvents: 2 });
  assert.ok(r.events <= 2, `events=${r.events}`);
  assert.ok(r.timeline.length <= 3, `timeline=${r.timeline.length}`); // initial + up to 2
  assert.ok(!r.settled, 'should stop before everything rests');
});

// Same input => byte-identical output.
test('simulation is deterministic', () => {
  const build = () => [
    man('a', v.vec(0, 0), v.fromAngle(0.7, 3.0)),
    man('b', v.vec(0.05, -0.05), v.fromAngle(2.1, 2.0)),
    man('c', v.vec(-0.08, 0.06), v.fromAngle(-1.2, 2.5)),
  ];
  const r1 = simulate({ bodies: build() });
  const r2 = simulate({ bodies: build() });
  assert.deepEqual(r1.timeline, r2.timeline);
});

// The shot vector is applied to the named striker.
test('shot vector is applied to the striker', () => {
  const s = man('striker', v.vec(0, 0));
  const target = man('t', v.vec(0.15, 0));
  const r = simulate({ bodies: [s, target] }, { strikerId: 'striker', angle: 0, speed: 1.0 });
  assert.ok(r.settled);
  assert.ok(target.pos.x > 0.15, 'target should have been struck forward');
});
