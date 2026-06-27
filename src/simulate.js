// simulate.js — public API.
//
//   simulate(layout, shot, opts) -> { bodies, pocketed, timeline }
//     layout: { bodies: Body[] }     all static except...
//     shot:   { strikerId, angle, speed }   the one struck body's initial vector
//     opts:   { maxEvents }          optional cap for a look-ahead preview
//
// This is the whole point of the project: static board + one vector in,
// predicted final resting positions out.

import { runEngine } from './engine.js';

export function simulate(layout, shot, opts) {
  return runEngine(layout, shot, opts);
}
