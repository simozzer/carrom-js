import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body } from '../src/body.js';
import { resolvePair, resolveWall } from '../src/collisions.js';
import { simulate } from '../src/simulate.js';
import { PUCK, STRIKER, PUCK_FRICTION_T } from '../src/board.js';
import * as v from '../src/vec2.js';

// --- helpers ----------------------------------------------------------------
const inertia = (b) => 0.5 * b.mass * b.radius * b.radius; // uniform disc
const cross2 = (a, b) => a.x * b.y - a.y * b.x;
const momentum = (...bs) => bs.reduce((s, b) => v.add(s, v.scale(b.vel, b.mass)), v.vec(0, 0));
const angMom = (C, ...bs) =>
  bs.reduce((s, b) => s + inertia(b) * b.omega + b.mass * cross2(v.sub(b.pos, C), b.vel), 0);
const kinetic = (...bs) =>
  bs.reduce((s, b) => s + 0.5 * b.mass * v.len2(b.vel) + 0.5 * inertia(b) * b.omega * b.omega, 0);

function mk(id, pos, vel, omega, r, m) {
  const b = new Body({ id, kind: 'man', pos, vel, radius: r, mass: m });
  b.omega = omega;
  return b;
}
// Striker (a) placed EXACTLY in contact (centres sumRadii apart) at angle `th` from man (b).
function touchingPair(th, velA, omA, velB, omB) {
  const R = STRIKER.radius + PUCK.radius;
  return [
    mk('a', v.fromAngle(th, R), velA, omA, STRIKER.radius, STRIKER.mass),
    mk('b', v.vec(0, 0), velB, omB, PUCK.radius, PUCK.mass),
  ];
}
const newStriker = () =>
  new Body({ id: 'striker', kind: 'striker', pos: v.vec(0, -0.25), radius: STRIKER.radius, mass: STRIKER.mass });

// --- conservation laws at a frictional ("throw") collision ------------------
test('frictional collision conserves linear momentum, conserves angular momentum about the contact, never gains KE', () => {
  const [a, b] = touchingPair((70 * Math.PI) / 180, v.vec(-0.2, -1.5), 80, v.vec(-0.1, 0.05), -30);
  const n = v.normalize(v.sub(a.pos, b.pos));
  const C = v.sub(a.pos, v.scale(n, a.radius)); // the contact point (same from either disc)
  const p0 = momentum(a, b);
  const l0 = angMom(C, a, b);
  const k0 = kinetic(a, b);
  resolvePair(a, b, 0.8, PUCK_FRICTION_T);
  const p1 = momentum(a, b);
  assert.ok(Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-12, 'linear momentum conserved');
  assert.ok(Math.abs(angMom(C, a, b) - l0) < 1e-12, 'angular momentum about contact conserved');
  assert.ok(kinetic(a, b) <= k0 + 1e-15, 'kinetic energy does not increase (friction dissipates)');
});

// --- throw direction --------------------------------------------------------
test('spin sign sets the sideways throw on a head-on hit, mirror-symmetric', () => {
  const headOn = (omega) => {
    const a = mk('a', v.vec(0, -(STRIKER.radius + PUCK.radius)), v.vec(0, 2), omega, STRIKER.radius, STRIKER.mass);
    const b = mk('b', v.vec(0, 0), v.vec(0, 0), 0, PUCK.radius, PUCK.mass);
    resolvePair(a, b, 0.8, PUCK_FRICTION_T);
    return b.vel.x;
  };
  assert.ok(Math.abs(headOn(0)) < 1e-12, 'no spin → no sideways throw');
  const ccw = headOn(120);
  const cw = headOn(-120);
  assert.ok(ccw < -1e-6 && cw > 1e-6, 'opposite spin throws the opposite way');
  assert.ok(Math.abs(ccw + cw) < 1e-9, 'mirror-symmetric in spin sign');
});

// --- opt-in: muT = 0 is byte-identical to the old (frictionless) resolver ----
test('muT defaults to 0: a glancing spinning hit leaves spin untouched and matches no-friction', () => {
  const build = () => [
    mk('a', v.vec(0, -(STRIKER.radius + PUCK.radius)), v.vec(0.3, 2), 100, STRIKER.radius, STRIKER.mass),
    mk('b', v.vec(0, 0), v.vec(0, 0), 0, PUCK.radius, PUCK.mass),
  ];
  const [a0, b0] = build();
  resolvePair(a0, b0, 0.8, 0);
  const [a1, b1] = build();
  resolvePair(a1, b1, 0.8); // default 4th arg
  assert.deepEqual(a0.vel, a1.vel);
  assert.deepEqual(b0.vel, b1.vel);
  assert.equal(a0.omega, 100, 'spin unchanged when muT=0');
  assert.equal(b0.omega, 0);
});

// --- cushion throw ----------------------------------------------------------
test('resolveWall: muT=0 is a plain reflection; muT>0 converts spin into tangential velocity', () => {
  const make = () => mk('w', v.vec(0, 0), v.vec(2, 0), 150, PUCK.radius, PUCK.mass);
  const plain = make();
  resolveWall(plain, 'x', 0.6); // default muT=0
  assert.ok(Math.abs(plain.vel.x + 1.2) < 1e-12, 'normal reflected with restitution');
  assert.equal(plain.vel.y, 0, 'no tangential change without friction');
  assert.equal(plain.omega, 150, 'spin untouched without friction');

  const thrown = make();
  resolveWall(thrown, 'x', 0.6, 1e-3, 0.2);
  assert.ok(Math.abs(thrown.vel.x + 1.2) < 1e-12, 'normal reflection identical');
  assert.ok(Math.abs(thrown.vel.y) > 1e-6, 'spin produced tangential (throw) velocity');
  assert.ok(thrown.omega !== 150, 'spin was exchanged');
});

// --- engine wiring: off-centre strike, opt-in, end-to-end deflection --------
test('off-centre strike sets ω = 2·spin·speed/radius (only with opts.spin)', () => {
  const bodies = [newStriker()];
  simulate({ bodies }, { strikerId: 'striker', angle: Math.PI / 2, speed: 4, spin: 0.7 }, { spin: true, maxEvents: 0, timeline: false });
  assert.ok(Math.abs(bodies[0].omega - (2 * 0.7 * 4) / STRIKER.radius) < 1e-9);
});

test('spin is ignored unless opts.spin is enabled', () => {
  const bodies = [newStriker()];
  simulate({ bodies }, { strikerId: 'striker', angle: Math.PI / 2, speed: 4, spin: 0.7 }, { maxEvents: 0, timeline: false });
  assert.equal(bodies[0].omega, 0);
});

test('a spun shot deflects a head-on coin; opposite spins deflect opposite ways', () => {
  const finalX = (spin) => {
    const bodies = [
      new Body({ id: 'm', kind: 'man', pos: v.vec(0, 0), radius: PUCK.radius, mass: PUCK.mass }),
      new Body({ id: 'striker', kind: 'striker', pos: v.vec(0, -0.12), radius: STRIKER.radius, mass: STRIKER.mass }),
    ];
    simulate({ bodies }, { strikerId: 'striker', angle: Math.PI / 2, speed: 3.5, spin }, { spin: true, timeline: false });
    return bodies.find((b) => b.id === 'm').pos.x;
  };
  assert.ok(Math.abs(finalX(0)) < 2e-3, 'no spin → coin travels straight');
  const left = finalX(-0.8);
  const right = finalX(0.8);
  assert.ok(Math.sign(left) === -Math.sign(right), 'opposite spins deflect opposite ways');
  assert.ok(Math.abs(left) > 5e-3 && Math.abs(right) > 5e-3, 'deflection is non-trivial');
});
