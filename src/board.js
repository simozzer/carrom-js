// board.js — Carrom geometry & physics constants. SI units (metres, kg, seconds).
// Dimensions follow the ICF (International Carrom Federation) standard board.
// Tune FRICTION_MU / restitution against real shots.

export const BOARD = {
  size: 0.737, // 29" inner playing square (m)
  pocketRadius: 0.02225, // ⌀44.5 mm corner pockets (ICF)
  cushionRestitution: 0.6,
};

export const GRAVITY = 9.81;
export const FRICTION_MU = 0.1; // board kinetic friction coefficient

export const PUCK = { radius: 0.0159, mass: 0.005 }; // carrom man ⌀31.8 mm, ~5 g
export const STRIKER = { radius: 0.02065, mass: 0.015 }; // striker ⌀41.3 mm, ~15 g
export const QUEEN = { radius: 0.0159, mass: 0.005 }; // queen = carrom-man size, red
export const PUCK_RESTITUTION = 0.8;

// Phase 3 (spin / "throw"): tangential friction coefficients at impulsive contacts. The
// tangential impulse that exchanges spin <-> sideways velocity is Coulomb-clamped to
// muT * |normal impulse|. Opt-in via simulate(..., { spin: true }).
export const PUCK_FRICTION_T = 0.12; // disc–disc throw
export const CUSHION_FRICTION_T = 0.2; // disc–cushion throw

// Inward-facing axis bounds, board centred on the origin.
export const walls = () => {
  const h = BOARD.size / 2;
  return { minX: -h, maxX: h, minY: -h, maxY: h };
};

// Four corner pockets, fully contained in the play area: each hole is seated tangent to
// both cushions (centre inset one radius from each edge), so the whole circle sits inside.
export const pockets = () => {
  const h = BOARD.size / 2;
  const o = h - BOARD.pocketRadius;
  return [
    { x: -o, y: -o },
    { x: o, y: -o },
    { x: -o, y: o },
    { x: o, y: o },
  ].map((c) => ({ center: c, radius: BOARD.pocketRadius }));
};
