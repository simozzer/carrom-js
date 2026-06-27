// setup.js — board layouts.
//
// standardOpening(): queen (red) at the centre, 18 men packed in two concentric rings
// around it (colours alternating), striker on the bottom baseline. Not tournament-exact,
// but a realistic packed cluster for exercising the break. Rings use a small gap so no
// two pieces start in exact contact.

import { Body } from './body.js';
import { PUCK, QUEEN, STRIKER } from './board.js';
import * as v from './vec2.js';

export function standardOpening() {
  const r = PUCK.radius;
  const bodies = [
    new Body({ id: 'queen', kind: 'queen', pos: v.vec(0, 0), radius: QUEEN.radius, mass: QUEEN.mass }),
  ];

  const rings = [
    { n: 6, rad: 2.06 * r, off: 0 },
    { n: 12, rad: 4.1 * r, off: Math.PI / 12 },
  ];
  let id = 0;
  for (const ring of rings) {
    for (let k = 0; k < ring.n; k++) {
      const a = ring.off + (k / ring.n) * Math.PI * 2;
      const m = new Body({
        id: `m${id}`,
        kind: 'man',
        pos: v.vec(Math.cos(a) * ring.rad, Math.sin(a) * ring.rad),
        radius: r,
        mass: PUCK.mass,
      });
      m.color = id % 2 === 0 ? 'white' : 'black';
      bodies.push(m);
      id += 1;
    }
  }

  bodies.push(
    new Body({ id: 'striker', kind: 'striker', pos: v.vec(0, -0.25), radius: STRIKER.radius, mass: STRIKER.mass }),
  );
  return bodies;
}
