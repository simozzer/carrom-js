import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standardOpening } from '../src/setup.js';
import { simulate } from '../src/simulate.js';
import { walls } from '../src/board.js';
import * as v from '../src/vec2.js';

test('standard opening has 20 pieces: queen + 18 men + striker', () => {
  const b = standardOpening();
  assert.equal(b.length, 20);
  assert.equal(b.filter((x) => x.kind === 'man').length, 18);
  assert.equal(b.filter((x) => x.kind === 'queen').length, 1);
  assert.equal(b.filter((x) => x.kind === 'striker').length, 1);
});

test('no two pieces start overlapping, all inside the board', () => {
  const b = standardOpening();
  const w = walls();
  for (const x of b) {
    assert.ok(x.pos.x >= w.minX + x.radius && x.pos.x <= w.maxX - x.radius);
    assert.ok(x.pos.y >= w.minY + x.radius && x.pos.y <= w.maxY - x.radius);
  }
  for (let i = 0; i < b.length; i++) {
    for (let j = i + 1; j < b.length; j++) {
      const gap = v.len(v.sub(b[i].pos, b[j].pos)) - (b[i].radius + b[j].radius);
      assert.ok(gap > -1e-9, `${b[i].id}/${b[j].id} overlap (gap ${gap})`);
    }
  }
});

// The real scenario: strike the packed cluster and confirm it resolves cleanly.
test('breaking the standard opening settles without hitting the event cap', () => {
  const bodies = standardOpening();
  const r = simulate({ bodies }, { strikerId: 'striker', angle: Math.PI / 2 + 0.04, speed: 4.5 });
  assert.ok(r.settled, 'should come to rest');
  assert.ok(!r.hitCap, `should not hit the event cap (events=${r.events})`);
  const w = walls();
  for (const b of bodies) {
    if (b.pocketed) continue;
    assert.ok(b.pos.x >= w.minX + b.radius - 1e-6 && b.pos.x <= w.maxX - b.radius + 1e-6);
    assert.ok(b.pos.y >= w.minY + b.radius - 1e-6 && b.pos.y <= w.maxY - b.radius + 1e-6);
  }
});
