# Carrom-JS

Event-driven 2D physics predictor for [Carrom](https://en.wikipedia.org/wiki/Carrom).
Pure ES6, zero dependencies.

**Goal:** given a static board layout and a single striker vector (angle + speed),
deterministically predict every piece's final resting position and what got pocketed.

This is the JavaScript continuation of the Free Pascal event-driven CCD engine in the
`Physics` / `In a bounded box` notes — same philosophy (solve exact event times, process
in chronological order, no fixed time-stepping), corrected and extended for Carrom.

## Core idea

Every body exposes a **trajectory** `posAt(t)` valid within the current phase (between
events). One bracketed root-finder detects the next contact for *every* event type
(puck-puck, wall, pocket, stop), unifying the three separate solvers from the Delphi
notes. The engine emits a **timeline** of events; the canvas renderer replays it by
interpolation — it never re-simulates.

## How the trajectory planning works (in plain terms)

When you line up a shot, the faint lines you see are not a guess — they're the **real
game played in fast-forward**. The same physics engine that runs an actual shot is asked,
"if I fired *this* shot right now, what would happen?", and it draws the answer.

The trick that makes it fast is that the engine never crawls forward in tiny time-steps.
Each puck slides in a straight line and slows to a stop at a steady rate (table friction),
so its whole path is described by one little formula. That means the engine can **jump
straight from one collision to the next**: it works out *exactly* when the next two pucks
(or a puck and a cushion, or a puck and a pocket) will touch, leaps to that instant,
bounces them, and repeats. Finding that "when" is just solving an equation — for two
sliding pucks it's a quartic (a degree-4 polynomial), which we solve directly rather than
by trial and error. A whole shot resolves in a few milliseconds.

For the on-screen preview the engine is run the same way but **stopped after a set number
of collisions** — the *Trajectories* menu (None / Immediate = 2 / Full = 30). It traces
the striker's path and the path of anything it hits, then the renderer draws those lines.
Because it's the exact same engine, **what it draws is what will happen** when you fire.

The faint **fan** is the same prediction repeated for a handful of slightly different aim
angles. If the lines stay bundled together, the shot is forgiving; if they spray apart,
the shot is touchy — a tiny aiming error changes everything. (That spray is real: once the
striker buries into the packed cluster, the outcome becomes genuinely chaotic, so the
deepest part of a break is more "illustrative" than a promise.)

The computer opponent uses the very same look-ahead to *choose* its shot: it tries a
handful of candidate aims, simulates each, and picks the one that pots a coin without
scratching — then shows you that planned line for a moment before it plays.

## Layout

```
src/
  vec2.js        immutable 2D vector ops
  roots.js       quadratic solver + bracketed first-root finder
  board.js       real Carrom dimensions, walls, pockets, friction, restitution
  body.js        a disc + its per-phase trajectory
  events.js      event detection (pair / wall / pocket / stop)        [Phase 1/2]
  collisions.js  impulse resolution (linear; +angular in Phase 3)     [Phase 1/3]
  engine.js      the event loop                                       [Phase 1]
  setup.js       standard opening layout + custom layouts             [Phase 2]
  simulate.js    public API: simulate(layout, shot) -> result
web/
  index.html     canvas page
  renderer.js    board draw + timeline playback                       [Phase 2]
test/            vec2, roots, invariants, golden scenarios, determinism
```

## Fixes carried over from the Delphi notes

- **Coulomb kinetic friction**, not a constant `-X` deceleration vector: friction opposes
  each body's own velocity and brings it to **rest** (it must not reverse at zero speed).
- **Real masses / sizes / restitution** for striker, men, queen.
- **Determinism** is a hard requirement: no randomness, stable ordering, explicit
  tie-breaking on simultaneous events.

## Roadmap

- **P0 — Scaffold** *(done)*: `vec2`, `roots`, tests.
- **P1 — Exact engine, no spin** *(done)*: straight-line friction, puck/puck + wall
  collisions, linear impulse with restitution, terminate-at-rest. Validated with physics
  invariants (momentum + KE conservation, e=0/e=1, head-on exchange), golden scenarios,
  determinism, "nothing escapes the board", and a 13-body cluster-break stress.
- **P2 — Board + pockets + visualiser**: real dimensions, pockets, standard opening,
  canvas playback. Watch the break.
- **P3 — Spin / angular**: curved spinning trajectories (numerical root-finding drives all
  detection), tangential contact friction → spin transfer, slide-to-roll.
- **P4 — 2-player game** *(done)*: turn flow with continuation, striker fouls
  (incl. three-consecutive-foul penalty), opponent-credit, queen pocket-and-cover,
  win detection; rules in `src/game.js` (unit-tested) with a turn-based scoreboard.
- **Scoring & match** *(done)*: board winner scores 1 point per opponent man left
  + 3 for a secured queen; match is first to 25 points or 8 boards (higher score),
  break alternates each board. `nextBoard` carries the score over; HUD shows points
  + board number. (Simplifications: no queen-score cap rule, no "due coin" defer.)
- **P5 — computer opponent** *(done)*: `src/ai.js` (unit-tested). `chooseShot`
  simulation-scores the top ghost-ball candidates over a bounded look-ahead and
  picks the outcome that pots without scratching — measured 0% fouls / ~76%
  own-pots over 120 shots, vs 43% / 28% for the geometry-only planner. Snappy:
  ~85 ms/turn mid-game, ~220 ms worst-case opening. Self-play (computer vs
  computer) or human White vs AI Black. A **difficulty selector** sets the AI's
  execution error (`applyError`): Perfect (none) → Hard → Medium → Easy →
  Beginner; the planner stays optimal, only execution gets less precise.
- **Sound** *(done)*: a synthesised wooden "knock" (Web Audio, no asset files) on
  each puck-puck and cushion collision during replay — cushion hits pitched lower
  than puck-puck, with slight per-hit variation. Toggle in the UI.
- **Analytic collision solver** *(done)*: pair/pocket contact times are solved in
  closed form — the relative motion is `p0 + v0 t + 0.5 a t²`, so `|Δp| = R` is a
  quartic, found via its critical points (cubic `q'=0`) + bisection (`roots.js`), no
  numerical scan. Cross-validated to zero mismatches vs the old fine scan over
  2500 random configs. ~20–60× faster: a full shot resolves in ~8 ms (was ~190),
  a 4-collision look-ahead in ~0.1 ms (was ~7.7).
- **Aim preview** *(done)*: hold then **drag to swing the aim** and watch the
  prediction update before you release. The engine runs an exact 30-collision
  look-ahead (`simulate(..., { maxEvents })`) drawing the predicted striker/piece
  paths, plus a faint **uncertainty fan** of perturbed-aim paths (tight bundle =
  reliable shot, wide spray = chaotic). Locked 60 fps in-browser even aiming
  straight into the pack.
- **Fine-tune aim** *(done)*: releasing the mouse locks the trajectory and power
  instead of firing; ← / → nudge the angle (hold for continuous), Enter fires,
  Esc cancels — so precise aim is achievable.

> Note: event-driven **+ spin** is the hard combination — spin curves the path and kills
> closed-form event times. P1 is built and fully validated on the exact straight-line
> model before P3 swaps in the curved trajectory.

## Run

```sh
npm test          # node --test
npm run serve     # serve project root; open http://localhost:8080/web/
```

Click on the board to flick the striker from its spot toward the cursor.
