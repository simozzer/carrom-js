import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newGame, takeShot, baselineY, strikerXLimit } from '../src/game.js';
import { planShot, jitterShot, chooseShot, applyError } from '../src/ai.js';

const blackToPlay = () => {
  const g = newGame();
  g.turn = 1;
  return g;
};

test('planShot returns a legal shot on the AI baseline, aimed into the board', () => {
  const s = planShot(blackToPlay());
  assert.ok(Math.abs(s.strikerPos.y - baselineY('black')) < 1e-9);
  assert.ok(Math.abs(s.strikerPos.x) <= strikerXLimit() + 1e-9);
  assert.ok(s.speed >= 2 && s.speed <= 6);
  assert.ok(Number.isFinite(s.angle));
  assert.ok(Math.sin(s.angle) < 0, 'from the top baseline the striker must travel downward');
});

test('jitterShot perturbs the angle by +/-10%, leaving speed alone', () => {
  let i = 0;
  const rng = () => [0.4, 1.0][i++]; // pickAngle=true, factor=1.10
  const j = jitterShot({ strikerPos: { x: 0, y: 0.25 }, angle: -1.5, speed: 4 }, rng);
  assert.equal(j.speed, 4);
  assert.ok(Math.abs(j.angle - -1.65) < 1e-9);
});

test('jitterShot perturbs the speed by +/-10%, leaving angle alone', () => {
  let i = 0;
  const rng = () => [0.6, 0.0][i++]; // pickAngle=false, factor=0.90
  const j = jitterShot({ strikerPos: { x: 0, y: 0.25 }, angle: -1.5, speed: 4 }, rng);
  assert.equal(j.angle, -1.5);
  assert.ok(Math.abs(j.speed - 3.6) < 1e-9);
});

test('chooseShot returns a legal shot on the AI baseline', () => {
  const g = blackToPlay();
  const s = chooseShot(g, { maxEvents: 25 });
  assert.ok(Math.abs(s.strikerPos.y - baselineY('black')) < 1e-9);
  assert.ok(Math.abs(s.strikerPos.x) <= strikerXLimit() + 1e-9);
  assert.ok(s.speed >= 2 && s.speed <= 6);
  assert.ok(Number.isFinite(s.angle));
});

test('applyError perturbs angle and power within bounds', () => {
  const shot = { strikerPos: { x: 0, y: 0.25 }, angle: -1.0, speed: 4.0 };
  // rng -> [angle draw, speed draw]; 1.0 = +max, 0.0 = -max
  let i = 0;
  const max = () => [1.0, 0.0][i++];
  const j = applyError(shot, {}, max);
  assert.ok(Math.abs(j.angle - -1.0 * 1.005) < 1e-9); // +0.5%
  assert.ok(Math.abs(j.speed - 4.0 * 0.95) < 1e-9); // -5%
  // mid draws leave it unchanged
  const same = applyError(shot, {}, () => 0.5);
  assert.equal(same.angle, -1.0);
  assert.equal(same.speed, 4.0);
});

test('applyError stays within the configured percentages over many draws', () => {
  const shot = { strikerPos: { x: 0, y: 0.25 }, angle: -1.2, speed: 5.0 };
  let seed = 1;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let n = 0; n < 500; n++) {
    const j = applyError(shot, {}, rng);
    assert.ok(Math.abs(j.angle / shot.angle - 1) <= 0.005 + 1e-12);
    assert.ok(Math.abs(j.speed / shot.speed - 1) <= 0.05 + 1e-12);
  }
});

test('an AI turn runs through the physics and conserves pieces', () => {
  const g = blackToPlay();
  const s = planShot(g);
  const r = takeShot(g, s.strikerPos, s.angle, s.speed);
  assert.ok(r.timeline.length > 0);
  assert.equal(g.pieces.filter((p) => p.color === 'white').length + g.pocketed.white, 9);
  assert.equal(g.pieces.filter((p) => p.color === 'black').length + g.pocketed.black, 9);
});
