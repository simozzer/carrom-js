// body.js — a moving disc with a per-phase trajectory.
//
// Phase 1: straight-line motion under constant kinetic deceleration, clamped to rest.
//   Friction opposes the body's OWN velocity (Coulomb), magnitude mu*g, and the body
//   STOPS at zero speed (it does not reverse — the bug in the original Delphi note).
// Phase 3: replace the trajectory helpers with the curved sliding-with-spin path.
//
// The trajectory math lives in standalone pure helpers so the renderer can replay a
// timeline with the exact same physics the engine used — no duplicated formula to drift.

import * as v from './vec2.js';
import { FRICTION_MU, GRAVITY } from './board.js';

const DECEL = FRICTION_MU * GRAVITY; // constant friction deceleration magnitude
const REST = 1e-9; // speed below which a body is considered at rest

export function stoppingTime(vel) {
  const sp = v.len(vel);
  if (sp <= REST) return 0;
  return DECEL > 0 ? sp / DECEL : Infinity;
}

// Position after dt of straight-line decelerating motion: p0 + dir*(v0 dt - 0.5 a dt^2),
// clamped at the stopping time.
export function positionAfter(pos, vel, dt) {
  const sp = v.len(vel);
  if (sp <= REST) return { x: pos.x, y: pos.y };
  const tt = Math.min(Math.max(dt, 0), stoppingTime(vel));
  const s = sp * tt - 0.5 * DECEL * tt * tt;
  return v.add(pos, v.scale(vel, s / sp));
}

// Velocity after dt (zero once stopped). Direction is constant during a phase.
export function velocityAfter(vel, dt) {
  const sp = v.len(vel);
  if (sp <= REST) return v.vec(0, 0);
  if (dt >= stoppingTime(vel)) return v.vec(0, 0);
  return v.scale(vel, (sp - DECEL * Math.max(dt, 0)) / sp);
}

export class Body {
  constructor({ id, kind, pos, vel = v.vec(0, 0), radius, mass }) {
    this.id = id;
    this.kind = kind; // 'striker' | 'man' | 'queen'
    this.pos = pos;
    this.vel = vel;
    this.radius = radius;
    this.mass = mass;
    this.omega = 0; // angular velocity — Phase 3
    this.pocketed = false;
  }

  get speed() {
    return v.len(this.vel);
  }

  get moving() {
    return this.speed > REST;
  }

  stopTime() {
    return stoppingTime(this.vel);
  }

  posAt(t) {
    return positionAfter(this.pos, this.vel, t);
  }

  velAt(t) {
    return velocityAfter(this.vel, t);
  }
}
