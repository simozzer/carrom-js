import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Body } from '../src/body.js';
import { simulate } from '../src/simulate.js';
import { PUCK, walls } from '../src/board.js';
import * as v from '../src/vec2.js';

const w = walls();
const corners = [
  v.vec(w.minX, w.minY),
  v.vec(w.maxX, w.minY),
  v.vec(w.minX, w.maxY),
  v.vec(w.maxX, w.maxY),
];
const man = (id, pos) => new Body({ id, kind: 'man', pos, radius: PUCK.radius, mass: PUCK.mass });
const angleTo = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);

test('a clean diagonal shot is pocketed in every corner', () => {
  for (const c of corners) {
    const start = v.scale(c, 0.55); // on the diagonal, well inside
    const a = man('a', start);
    const r = simulate({ bodies: [a] }, { strikerId: 'a', angle: angleTo(start, c), speed: 2.0 });
    assert.deepEqual(r.pocketed, ['a'], `corner ${c.x},${c.y} not potted`);
    assert.ok(a.pocketed && r.settled);
  }
});

test('a shot that stops short is not pocketed and settles on the board', () => {
  const start = v.scale(corners[3], 0.55);
  const a = man('a', start);
  const r = simulate({ bodies: [a] }, { strikerId: 'a', angle: angleTo(start, corners[3]), speed: 0.4 });
  assert.deepEqual(r.pocketed, []);
  assert.ok(r.settled && !a.pocketed);
  assert.ok(a.pos.x < w.maxX && a.pos.y < w.maxY);
});

test('pieces are conserved: pocketed + remaining = initial', () => {
  const bodies = [
    man('a', v.vec(0, 0)),
    man('b', v.vec(0.05, 0.05)),
    man('c', v.vec(-0.05, 0.05)),
  ];
  const r = simulate({ bodies }, { strikerId: 'a', angle: 0.9, speed: 4.0 });
  assert.ok(r.settled && !r.hitCap);
  const onBoard = bodies.filter((b) => !b.pocketed).length;
  assert.equal(onBoard + r.pocketed.length, bodies.length);
});

test('a pocketed body comes to rest and stays out of play', () => {
  const start = v.scale(corners[3], 0.55);
  const a = man('a', start);
  simulate({ bodies: [a] }, { strikerId: 'a', angle: angleTo(start, corners[3]), speed: 2.0 });
  assert.ok(a.pocketed);
  assert.equal(a.speed, 0);
  assert.equal(typeof a.pocket, 'number'); // records which pocket
});

test('potting is deterministic', () => {
  const build = () => [man('a', v.vec(0, 0)), man('t', v.vec(0.15, 0.15))];
  const r1 = simulate({ bodies: build() }, { strikerId: 'a', angle: Math.PI / 4, speed: 3.0 });
  const r2 = simulate({ bodies: build() }, { strikerId: 'a', angle: Math.PI / 4, speed: 3.0 });
  assert.deepEqual(r1.timeline, r2.timeline);
  assert.deepEqual(r1.pocketed, r2.pocketed);
});
