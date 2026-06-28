// renderer.js — 2-player Carrom: board, turn flow, aiming, and timeline replay.
// Serve from the PROJECT ROOT (npm run serve) and open /web/ — file:// blocks ES imports.
//
// A turn: drag the striker along the current player's baseline, set the power on the
// vertical slider in the right margin, then drag on the board to aim and release to lock
// into fine-tune (←/→ nudge the angle, Enter fires). Pocket your own men to keep playing;
// the rules (continuation, fouls, queen cover, win) live in src/game.js.

import { BOARD, walls, pockets, PUCK, QUEEN, STRIKER } from '../src/board.js';
import { positionAfter } from '../src/body.js';
import { newGame, nextBoard, takeShot, shotBodies, turnColor, baselineY, strikerHome, BASE_HALF, BASE_CIRCLE_R, strikerXLimit, clampForwardAngle } from '../src/game.js';
import { simulate } from '../src/simulate.js';
import { chooseShot, applyError } from '../src/ai.js';
import * as v from '../src/vec2.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const PX = canvas.width;

const MARGIN = 35; // wooden frame width around the play square (slim — controls live in it)
const INNER = PX - 2 * MARGIN;
const toPx = (m) => MARGIN + (m / BOARD.size + 0.5) * INNER;
const scalePx = (m) => (m / BOARD.size) * INNER;
const toWorld = (px) => ((px - MARGIN) / INNER - 0.5) * BOARD.size;

const COLORS = { white: '#f3ead3', black: '#525a63', queen: '#b03030', striker: '#37306b' };

// On a touch device the slim on-canvas controls are tiny under a finger, so we grow their
// HIT areas (not their drawn size) by HIT_PAD. `(any-pointer: coarse)` is true whenever a
// touch pointer exists, so hybrid laptops just get slightly more forgiving targets too.
const COARSE = typeof window !== 'undefined' && window.matchMedia?.('(any-pointer: coarse)')?.matches;
const HIT_PAD = COARSE ? 16 : 0; // px (canvas space) of extra slop around touch targets

// Power slider, drawn vertically in the right margin. Bottom = 0, top = MAX_SPEED.
const SLIDER = { x: PX - MARGIN / 2, top: MARGIN, bottom: PX - MARGIN, w: 12, hitW: 34 };
const sliderH = () => SLIDER.bottom - SLIDER.top;
const powerToY = (p) => SLIDER.bottom - (p / MAX_SPEED) * sliderH();
const yToPower = (py) => Math.max(0, Math.min(1, (SLIDER.bottom - py) / sliderH())) * MAX_SPEED;
const onSlider = (px, py) =>
  px >= SLIDER.x - SLIDER.hitW / 2 - HIT_PAD && px <= SLIDER.x + SLIDER.hitW / 2 + HIT_PAD &&
  py >= SLIDER.top - 12 - HIT_PAD && py <= SLIDER.bottom + 12 + HIT_PAD;


// Fine-tune controls, drawn as a row in the bottom margin (same on-canvas "control area" as
// the slider). Only live while a shot is locked for fine-tuning. The angle buttons hold-to-
// repeat via the leftHeld/rightHeld flags the arrow keys also drive.
const FT = { y: PX - 31, h: 26, gap: 8, x0: MARGIN + 6, x1: SLIDER.x - SLIDER.hitW / 2 - 8 };
const FT_BUTTONS = [
  { id: 'left', label: '◀ angle', accent: '#8a8a8a' },
  { id: 'fire', label: 'Fire', accent: '#2e8b57' },
  { id: 'cancel', label: 'Cancel', accent: '#c0392b' },
  { id: 'right', label: 'angle ▶', accent: '#8a8a8a' },
];
const ftRect = (i) => {
  const w = (FT.x1 - FT.x0 - (FT_BUTTONS.length - 1) * FT.gap) / FT_BUTTONS.length;
  return { x: FT.x0 + i * (w + FT.gap), y: FT.y, w, h: FT.h };
};
// Which fine-tune button (id) is at pixel (px,py), or null. Live only during fine-tuning.
// On touch the hit box grows: full pad vertically (the bottom margin is thin), but only half
// the gap horizontally so neighbouring buttons' touch zones don't overlap.
function ftButtonAt(px, py) {
  if (!adjusting) return null;
  const padX = Math.min(HIT_PAD, FT.gap / 2);
  for (let i = 0; i < FT_BUTTONS.length; i++) {
    const r = ftRect(i);
    if (px >= r.x - padX && px <= r.x + r.w + padX && py >= r.y - HIT_PAD && py <= r.y + r.h + HIT_PAD) return FT_BUTTONS[i].id;
  }
  return null;
}
let ftPressed = null; // id of the button currently held down
let ftHover = null; // id of the button under the cursor (hover styling)

const MAX_SPEED = 6.0; // m/s at full power (top of the slider)
const PLAYBACK_RATE = 0.6; // <1 plays the shot back slower than real time
// Trajectory-depth menu: how many collisions the preview looks ahead (0 = off).
const TRAJECTORY = { none: 0, immediate: 2, full: 30 };
const trajectoryDepth = () => TRAJECTORY[document.getElementById('trajectory')?.value] ?? TRAJECTORY.full;
const PREVIEW_REFRESH_MS = 40; // recompute throttle (analytic solver is cheap → responsive)

let game = newGame();
let mode = 'aiming'; // 'aiming' | 'animating' | 'gameover'
let strikerPos = strikerHome(turnColor(game));

const selfPlay = () => document.getElementById('selfplay')?.checked;

// Difficulty = how much execution error the AI gets (perfect = none = hardest).
// The AI's shot search. `search` (passed to chooseShot) is the AI's *brain* — how many
// lines/power/angle/spin variants it evaluates. anglePct/speedPct are its *hand* — execution
// error. Deadly = perfect hand AND a much bigger brain: a dense candidate × power × angle ×
// spin grid (~3.8k look-aheads) that pots 2+ coins in essentially every position. That's ~5×
// the compute of the other levels, but the multi-worker pool fans it across CPU cores, so it
// still lands in a few tenths of a second.
const AI_SEARCH = { spins: [-0.7, 0, 0.7] }; // standard search for every level
const DEADLY_SEARCH = {
  maxCandidates: 18,
  powerScales: [0.7, 0.85, 1.0, 1.15, 1.3],
  angleOffsets: [-0.02, -0.012, -0.004, 0.004, 0.012, 0.02],
  spins: [-0.8, -0.5, -0.25, 0, 0.25, 0.5, 0.8],
};
const DIFFICULTY = {
  deadly: { anglePct: 0, speedPct: 0, search: DEADLY_SEARCH },
  perfect: { anglePct: 0, speedPct: 0 },
  hard: { anglePct: 0.0025, speedPct: 0.025 },
  medium: { anglePct: 0.005, speedPct: 0.05 },
  easy: { anglePct: 0.01, speedPct: 0.1 },
  beginner: { anglePct: 0.02, speedPct: 0.2 },
};
const difficulty = () => DIFFICULTY[document.getElementById('difficulty')?.value] ?? DIFFICULTY.medium;
// Black is always the computer; in self-play White is too.
const isAiTurn = () => !game.winner && (selfPlay() || turnColor(game) === 'black');
const RESULT_HOLD_MS = 1000; // hold the shot result before the AI reacts
const THINK_MS = 350; // brief "thinking" pause before the AI positions the striker
const AI_SLIDE_MS = 350; // striker slides to its chosen start position
const AI_CHARGE_MS = 350; // power slider ramps up to the chosen speed
const AI_PAUSE = 250; // a beat held after each setup step (aim, charge, fire) so it's watchable

// replay state
let timeline = [];
let meta = new Map();
let endT = 0;
let startedAt = 0;
let soundIdx = 0; // index of the last collision whose knock has played
const SETTLE_HOLD_MS = 300; // hold the final resting frame this long before resolving the turn
let settleAt = 0; // timestamp when all pieces came to rest (0 = not yet)

// --- sound: a synthesised "knock" on each puck/puck and wall collision -------
let audioCtx = null;
// Create/resume the audio context — only ever called from a user gesture, so the browser
// allows it and doesn't log "AudioContext was not allowed to start".
function unlockAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    /* ignore */
  }
}
const soundOn = () => document.getElementById('sound')?.checked;
const KNOCK_FULL_SPEED = 3.5; // impact speed (m/s) at which a knock is at full volume
// A short band-passed noise burst — a hard plastic/wood "clack", not a tonal drum. Impact
// speed (`intensity`, m/s) sets the volume and the brightness (band centre); a high filter Q
// makes the noise ring briefly at a pitch so it reads as a click, not a hiss. The very short
// decay is what keeps it snappy rather than log-drum-y.
function knock(kind, intensity = KNOCK_FULL_SPEED) {
  // stay silent until audio has been unlocked by a gesture and is actually running
  if (!soundOn() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const ctx = audioCtx;
    const t = ctx.currentTime;
    const wall = kind === 'wall';
    const hard = Math.max(0, Math.min(1, intensity / KNOCK_FULL_SPEED)); // 0 (soft) .. 1 (full smash)

    // white-noise burst = the impact transient
    const len = Math.ceil(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;

    // band-pass with high Q rings the noise at a pitch → a "clack". Cushion lower & duller
    // than disc-on-disc; harder hits open brighter. (Pitch tracks the objects, not the speed.)
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    const centre = (wall ? 1100 : 2200) * (0.9 + Math.random() * 0.2); // slight per-hit variation
    bp.frequency.value = centre + hard * (wall ? 500 : 1200);
    bp.Q.value = wall ? 4 : 7;

    const g = ctx.createGain();
    const peak = (wall ? 0.5 : 0.6) * Math.max(0.12, hard); // softer hits quieter (12% floor)
    const decay = wall ? 0.05 : 0.03; // short & snappy (was ~0.08s tonal → drum-like)
    g.gain.setValueAtTime(Math.max(0.0003, peak), t); // instant attack = the clack
    g.gain.exponentialRampToValueAtTime(0.0003, t + decay);

    src.connect(bp).connect(g).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.06);
  } catch {
    /* no audio device available — play silently */
  }
}

// interaction state
let aiSlide = null; // AI: { fromX, toX, y, startedAt, shot } while sliding the striker into place
let dragging = false; // dragging the striker along the baseline
let holding = false; // dragging on the board to set the aim direction
let sliderDragging = false; // dragging the power slider
const DEFAULT_POWER = 1.0; // m/s — the slider resets here at the start of each turn
let power = DEFAULT_POWER; // m/s — set by the slider, reset every turn
let spin = 0; // −1 (full left) .. +1 (full right) strike offset; reset every turn

// Spin slider lives below the board (HTML <input type=range>). Drives the off-centre-strike
// spin / "throw" physics; the preview recomputes so the predicted path shows the curve.
const spinInput = document.getElementById('spin');
const spinVal = document.getElementById('spin-val');
function syncSpinLabel() {
  const s = spin;
  spinVal.textContent = Math.abs(s) < 0.005 ? '0' : `${s > 0 ? 'R' : 'L'} ${Math.abs(s).toFixed(2)}`;
}
spinInput?.addEventListener('input', () => {
  const s = parseFloat(spinInput.value);
  spin = Math.abs(s) < 0.04 ? 0 : s; // dead-zone at centre so "no spin" is easy to hit
  previewCache = null; // refresh the preview so the throw shows
  syncSpinLabel();
});
let aimAngle = 0;
let aimPoint = null;
let previewCache = null; // { main: Map<id, pts[]> }
let previewAt = 0;

// fine-tune (adjust) phase: after releasing, lock angle/power; arrows nudge, Enter fires
let adjusting = false;
let lockedAngle = 0;
let lockedSpeed = 0;
let leftHeld = false;
let rightHeld = false;
let holdFrames = 0; // consecutive frames an arrow has been held (drives acceleration)
let holdDir = 0;
const ADJUST_STEP = 0.0004; // base radians/frame — a quick tap is a fine nudge (~0.023°)
const ADJUST_ACCEL_MAX = 10; // holding ramps the step up to this multiple of the base
const ADJUST_RAMP_FRAMES = 75; // frames (~1.25s held) to reach full acceleration

// effective aim used by the preview: locked while fine-tuning, live (slider) while aiming
const aimAngleNow = () => (adjusting ? lockedAngle : aimAngle);
const aimSpeedNow = () => (adjusting ? lockedSpeed : power);

const hud = {
  white: document.getElementById('n-white'),
  black: document.getElementById('n-black'),
  pWhite: document.getElementById('p-white'),
  pBlack: document.getElementById('p-black'),
  sWhite: document.getElementById('s-white'),
  sBlack: document.getElementById('s-black'),
  queen: document.getElementById('queen'),
  boardInfo: document.getElementById('board-info'),
  msg: document.getElementById('msg'),
};

let lastMsg = null;
function setMessage(text) {
  if (text === lastMsg) return;
  lastMsg = text;
  hud.msg.textContent = text;
  hud.msg.animate(
    [{ transform: 'scale(1)' }, { transform: 'scale(2)' }, { transform: 'scale(1)' }],
    { duration: 600, easing: 'ease-in-out' },
  );
}

// Stage-aware "what to do now" banner above the board. Mirrors the interaction state so the
// player always sees the current step of setting up a shot. { step, text } -> banner HTML.
const howtoEl = document.getElementById('howto');
function howtoStage() {
  if (mode === 'gameover') return { step: 'Board over', text: 'Click the board to start the next board or match.' };
  if (mode === 'animating') return { step: 'In play', text: 'Watching the shot — see where the pieces settle.' };
  if (isAiTurn() || aiSlide) return { step: 'Opponent', text: 'The computer is lining up its shot — sit tight.' };
  if (adjusting) return { step: 'Step 4 · Fine-tune', text: 'Nudge the angle with ← → or the on-screen buttons, then Fire (Enter). Esc cancels.' };
  if (holding) return { step: 'Step 3 · Aim', text: 'Drag to point the shot forward (you can’t fire sideways or backward) — release to lock it in.' };
  if (dragging) return { step: 'Step 1 · Position', text: 'Slide the striker along your baseline, then release.' };
  return { step: 'Your shot', text: '① Drag the striker · ② power (right slider) · ③ spin (slider below the board, L/R — optional) · ④ drag on the board to aim.' };
}

let lastHowto = null;
function updateHowto() {
  const { step, text } = howtoStage();
  const html = `<span class="step">${step}</span>${text}`;
  if (html === lastHowto) return;
  lastHowto = html;
  howtoEl.innerHTML = html;
}

function updateHud() {
  hud.white.textContent = game.pocketed.white;
  hud.black.textContent = game.pocketed.black;
  hud.pWhite.textContent = game.score.white;
  hud.pBlack.textContent = game.score.black;
  const active = game.matchWinner || game.winner || turnColor(game);
  document.body.classList.toggle('turn-white', active === 'white');
  document.body.classList.toggle('turn-black', active === 'black');
  const q = game.queen;
  hud.queen.textContent =
    q === 'board' ? 'Queen: on board' : q === 'pending' ? 'Queen: cover it!' : `Queen: ${q}'s`;
  hud.boardInfo.textContent = game.matchWinner
    ? 'Match over'
    : `Board ${game.boards + 1} of ${game.maxBoards} · first to ${game.target} pts`;
  const cont = game.matchWinner ? ' — click for a new match' : game.winner ? ' — click for the next board' : '';
  setMessage(game.message + cont);
}

const radiusOf = (color) => (color === 'queen' ? QUEEN.radius : color === 'striker' ? STRIKER.radius : PUCK.radius);

// True if the striker centred at (x, y) overlaps no on-board piece.
function clearAt(x, y) {
  return game.pieces.every((p) => {
    const rr = STRIKER.radius + radiusOf(p.color);
    return (p.pos.x - x) ** 2 + (p.pos.y - y) ** 2 >= rr * rr;
  });
}

// Nearest x on the baseline (within the legal range) to desiredX that doesn't overlap a piece.
function legalStrikerX(desiredX, y) {
  const lim = strikerXLimit();
  const x0 = Math.max(-lim, Math.min(lim, desiredX));
  if (clearAt(x0, y)) return x0;
  const step = STRIKER.radius * 0.1;
  for (let d = step; d <= 2 * lim; d += step) {
    if (x0 - d >= -lim && clearAt(x0 - d, y)) return x0 - d;
    if (x0 + d <= lim && clearAt(x0 + d, y)) return x0 + d;
  }
  return strikerPos.x; // no clear spot — keep current
}

// ---- board drawing ----------------------------------------------------------
const INK = 'rgba(110, 75, 40, 0.3)'; // faint playfield markings (squares, centre, arrows)
const RED = '#a8242a';

function wline(ax, ay, bx, by, width = 1.2, col = INK) {
  ctx.strokeStyle = col;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(toPx(ax), toPx(ay));
  ctx.lineTo(toPx(bx), toPx(by));
  ctx.stroke();
}

function wcircle(cx, cy, r, { stroke = INK, fill = null, width = 1.2 } = {}) {
  ctx.beginPath();
  ctx.arc(toPx(cx), toPx(cy), scalePx(r), 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

function arrow(angle, r0, r1) {
  const bx = Math.cos(angle) * r1;
  const by = Math.sin(angle) * r1;
  wline(Math.cos(angle) * r0, Math.sin(angle) * r0, bx, by, 1.4);
  const head = 0.016;
  for (const s of [0.82, -0.82]) {
    wline(bx, by, bx + Math.cos(angle + Math.PI * s) * head, by + Math.sin(angle + Math.PI * s) * head, 1.4);
  }
}

function fillSquare(half, color) {
  ctx.fillStyle = color;
  ctx.fillRect(toPx(-half), toPx(-half), scalePx(2 * half), scalePx(2 * half));
}

function drawMarkings() {
  for (const e of [0.27, 0.23]) {
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.strokeRect(toPx(-e), toPx(-e), scalePx(2 * e), scalePx(2 * e));
  }
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    wcircle(sx * BASE_HALF, sy * BASE_HALF, BASE_CIRCLE_R, { stroke: 'rgba(168, 36, 42, 0.4)', fill: null, width: 1.3 });
  }
  wcircle(0, 0, 0.085, { stroke: 'rgba(110, 75, 40, 0.18)', width: 1 });
  wcircle(0, 0, 0.024, { stroke: 'rgba(168, 36, 42, 0.4)', fill: 'rgba(168, 36, 42, 0.07)', width: 1.2 });
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    wline(Math.cos(a) * 0.03, Math.sin(a) * 0.03, Math.cos(a) * 0.044, Math.sin(a) * 0.044, 1.2);
  }
  for (const a of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) arrow(a, 0.1, 0.155);
}

function drawBoard() {
  const w = walls();
  ctx.fillStyle = '#5a3d1f';
  ctx.fillRect(0, 0, PX, PX);
  ctx.fillStyle = '#7a5326';
  ctx.fillRect(8, 8, PX - 16, PX - 16);
  // concentric board squares, each a slightly different hue
  fillSquare(BOARD.size / 2, 'hsl(36, 58%, 72%)'); // full play surface
  fillSquare(0.27, 'hsl(40, 61%, 74%)'); // outer base-line square
  fillSquare(0.23, 'hsl(44, 64%, 76%)'); // inner base-line square
  ctx.strokeStyle = '#3a2412';
  ctx.lineWidth = 2;
  ctx.strokeRect(toPx(w.minX), toPx(w.minY), scalePx(BOARD.size), scalePx(BOARD.size));
  drawMarkings();
  for (const p of pockets()) wcircle(p.center.x, p.center.y, p.radius, { stroke: '#1d120a', fill: '#241408', width: 2 });
}

// ---- pieces / aiming --------------------------------------------------------
function disc(x, y, r, fill) {
  ctx.beginPath();
  ctx.arc(toPx(x), toPx(y), scalePx(r), 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke();
}

function drawStatic() {
  for (const p of game.pieces) disc(p.pos.x, p.pos.y, radiusOf(p.color), COLORS[p.color]);
}

function drawStriker() {
  disc(strikerPos.x, strikerPos.y, STRIKER.radius, COLORS.striker);
}

function drawBaselineTrack() {
  const lim = strikerXLimit();
  const y = baselineY(turnColor(game));
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(toPx(-lim), toPx(y));
  ctx.lineTo(toPx(lim), toPx(y));
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(toPx(strikerPos.x), toPx(strikerPos.y), scalePx(STRIKER.radius) + 3, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// Per-body paths from a look-ahead timeline.
function pathsFromTimeline(timeline) {
  const paths = new Map();
  const sunk = new Set(); // pieces whose path has reached a pocket
  for (const snapshot of timeline) {
    for (const e of snapshot.bodies) {
      if (sunk.has(e.id)) continue; // path ends once it drops in
      if (!paths.has(e.id)) paths.set(e.id, []);
      paths.get(e.id).push(e.pos);
      if (e.pocketed) sunk.add(e.id); // include the pocket-entry point, then stop
    }
  }
  return paths;
}

function lookAhead(angle, speed, maxEvents) {
  const bodies = shotBodies(game, strikerPos);
  // include the current spin so the preview shows the throw; opts.spin enables Phase-3 physics
  return simulate({ bodies }, { strikerId: 'striker', angle, speed, spin }, { maxEvents, spin: spin !== 0 }).timeline;
}

// Recompute the exact predicted paths (throttled; cached between).
function computePreview(angle, speed, now) {
  previewCache = { main: pathsFromTimeline(lookAhead(angle, speed, trajectoryDepth())) };
  previewAt = now;
}

function polyline(pts) {
  ctx.beginPath();
  ctx.moveTo(toPx(pts[0].x), toPx(pts[0].y));
  for (let k = 1; k < pts.length; k++) ctx.lineTo(toPx(pts[k].x), toPx(pts[k].y));
  ctx.stroke();
}

function drawPreview(now, angle, speed) {
  if (trajectoryDepth() <= 0 || speed <= 0) {
    previewCache = null;
    return;
  }
  if (!previewCache || now - previewAt > PREVIEW_REFRESH_MS) computePreview(angle, speed, now);

  ctx.save();
  // exact predicted paths
  for (const [id, pts] of previewCache.main) {
    const last = pts[pts.length - 1];
    if (Math.abs(pts[0].x - last.x) < 1e-3 && Math.abs(pts[0].y - last.y) < 1e-3) continue;
    const isStriker = id === 'striker';
    ctx.strokeStyle = isStriker ? 'rgba(40,40,90,0.9)' : 'rgba(0,0,0,0.4)';
    ctx.lineWidth = isStriker ? 2 : 1.2;
    ctx.setLineDash(isStriker ? [] : [4, 4]);
    polyline(pts);
    ctx.setLineDash([]);
  }
  ctx.restore();
}

// The power slider: a vertical track in the right margin with a draggable handle.
// Filled from the bottom up to the current power; blue while fine-tuning, red at full.
function drawSlider() {
  const { x, top, bottom, w } = SLIDER;
  const handleY = powerToY(power);
  const frac = power / MAX_SPEED;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(x - w / 2, top, w, bottom - top); // track
  ctx.fillStyle = adjusting ? '#2e6da4' : frac >= 1 ? '#c0392b' : '#2e8b57';
  ctx.fillRect(x - w / 2, handleY, w, bottom - handleY); // fill up to power
  ctx.beginPath(); // handle
  ctx.arc(x, handleY, 9, 0, Math.PI * 2);
  ctx.fillStyle = sliderDragging ? '#fff' : '#e8e8e8';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('PWR', x, top - 9);
  ctx.fillText(power.toFixed(1), x, bottom + 17);
  ctx.restore();
}

// Trace a rounded-rect path (manual arcTo for broad canvas support).
function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The on-canvas fine-tune control row (bottom margin). Shown while the human is fine-tuning,
// or forced on (active:true) so the player can watch the computer drive it. Pressed = filled
// with the button's accent; hovered = lighter; idle = dark translucent. opts override which
// button reads as pressed/hovered (used to puppet the controls during the AI's turn).
function drawFineButtons({ active = adjusting, pressed = ftPressed, hover = ftHover } = {}) {
  if (!active) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '600 13px system-ui, sans-serif';
  for (let i = 0; i < FT_BUTTONS.length; i++) {
    const b = FT_BUTTONS[i];
    const r = ftRect(i);
    const isPressed = pressed === b.id;
    const isHover = hover === b.id;
    roundRectPath(r.x, r.y, r.w, r.h, 7);
    ctx.fillStyle = isPressed ? b.accent : isHover ? 'rgba(20,20,22,0.9)' : 'rgba(20,20,22,0.72)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = b.accent;
    ctx.stroke();
    ctx.fillStyle = isPressed ? '#fff' : '#eee';
    ctx.fillText(b.label, r.x + r.w / 2, r.y + r.h / 2 + 1);
  }
  ctx.restore();
}

function drawAim() {
  if (!holding) return;
  // cursor aim line only while actively dragging the aim
  if (aimPoint) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toPx(strikerPos.x), toPx(strikerPos.y));
    ctx.lineTo(toPx(aimPoint.x), toPx(aimPoint.y));
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(toPx(aimPoint.x), toPx(aimPoint.y), 5, 0, Math.PI * 2);
    ctx.fillStyle = '#b03030';
    ctx.fill();
  }
}

// ---- main loop --------------------------------------------------------------
function endShot() {
  mode = game.winner ? 'gameover' : 'aiming';
  power = DEFAULT_POWER; // reset the power slider for the new turn
  spin = 0; // reset spin for the new turn
  if (spinInput) spinInput.value = '0';
  syncSpinLabel();
  const home = strikerHome(turnColor(game));
  strikerPos = { x: legalStrikerX(home.x, home.y), y: home.y };
  updateHud();
  if (game.winner) {
    if (selfPlay()) {
      setTimeout(() => {
        if (game.matchWinner) game = newGame(); // new match
        else nextBoard(game); // next board, score carries over
        endShot();
      }, game.matchWinner ? 4000 : 2500);
    }
    return;
  }
  if (isAiTurn()) {
    // hold the result on screen, then show "thinking", then play
    const who = turnColor(game) === 'white' ? 'White' : 'Black';
    setTimeout(() => {
      if (!isAiTurn() || mode !== 'aiming') return;
      setMessage(`${who} (computer) thinking…`);
      setTimeout(aiMove, THINK_MS);
    }, RESULT_HOLD_MS);
  }
}

// The AI's shot search runs in a POOL of Web Workers — the candidate list is split across CPU
// cores (each worker scores its slice and returns its best; the main thread keeps the global
// max). This keeps the UI smooth (the "thinking…" frame keeps animating) AND uses every core,
// so a heavy Deadly search finishes in a fraction of the single-thread time. Falls back to a
// synchronous compute if module workers aren't available. The chosen line gets its
// execution-error wobble applied on the main thread (cheap, and keeps the workers pure).
const AI_POOL_SIZE = Math.max(2, Math.min((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4, 8));
const AI_TIMEOUT_MS = 8000; // safety net: a worker that dies / never loads must not hang the turn
let aiPool = null; // null = not built, false = unavailable, else Worker[]
let aiReqId = 0;
let aiPending = null; // in-flight fan-out: { reqId, diff, config, pending:Set<Worker>, got, replies, timer }
function ensureAiPool() {
  if (aiPool !== null || typeof Worker === 'undefined') return aiPool;
  try {
    aiPool = [];
    for (let i = 0; i < AI_POOL_SIZE; i++) {
      const w = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      // A worker answers with the reqId it was dispatched for; on error it carries none of its
      // own, so we use the reqId we stamped on it at dispatch (w._aiReq) — never the live
      // aiPending, which would mis-credit a stale error to a newer request.
      w.onmessage = (e) => aiResolve(w, e.data.reqId, e.data.shot, false);
      w.onerror = () => aiResolve(w, w._aiReq, null, true);
      aiPool.push(w);
    }
  } catch {
    aiPool = false;
  }
  return aiPool;
}
function startAiSlide(shot) {
  const toX = legalStrikerX(shot.strikerPos.x, shot.strikerPos.y);
  aiSlide = { fromX: strikerPos.x, toX, y: shot.strikerPos.y, startedAt: performance.now(), shot };
  previewCache = null; // fresh preview for the AI's chosen line
}
// A pool worker answered for `reqId` — a shot, an empty slice (null), or an error. Each worker
// counts at most once (tracked in `pending`), so neither a double-fire (message + error) nor a
// stale reply from a superseded request can mis-balance the tally or finalize early.
function aiResolve(worker, reqId, shot, isError) {
  if (!aiPending || reqId !== aiPending.reqId || !aiPending.pending.has(worker)) return;
  aiPending.pending.delete(worker);
  if (!isError) aiPending.replies += 1; // a delivered message (even a null shot) proves it's alive
  if (shot) aiPending.got.push(shot);
  if (aiPending.pending.size === 0) finalizeAiSearch();
}
// a worker never answered in time → stop waiting and decide with whatever came back.
function aiTimeout(reqId) {
  if (!aiPending || aiPending.reqId !== reqId) return;
  aiPending.pending.clear();
  finalizeAiSearch();
}
function finalizeAiSearch() {
  clearTimeout(aiPending.timer);
  const { got, diff, config, replies } = aiPending;
  aiPending = null;
  // No worker even delivered a message (all errored / timed out) → the pool is unusable (e.g.
  // module workers unsupported). Tear it down so later turns go straight to sync instead of
  // stalling on dead workers each time. (An empty `got` WITH replies>0 is a real no-candidate
  // position, not a broken pool — leave the pool intact.)
  if (replies === 0 && Array.isArray(aiPool)) { for (const w of aiPool) w.terminate(); aiPool = false; }
  if (!isAiTurn() || mode !== 'aiming' || aiSlide) return; // the turn moved on while it thought
  let best = null;
  for (const s of got) if (!best || s.score > best.score) best = s; // global best across slices
  // best is null only when no slice produced a shot — fall back to a full synchronous search
  // (chooseShot itself drops to planShot only if there genuinely are no candidates).
  startAiSlide(applyError(best ?? chooseShot(game, config), diff));
}

function aiMove() {
  if (!isAiTurn() || mode !== 'aiming') return;
  const diff = difficulty();
  // robust = avoid lines that self-pocket under the difficulty's wobble; search may also try
  // left/no/right spin (it keeps spin=0 unless a spun line scores better).
  const config = { robust: { anglePct: diff.anglePct, speedPct: diff.speedPct }, ...(diff.search ?? AI_SEARCH) };
  const pool = ensureAiPool();
  if (pool && pool.length) {
    const reqId = (aiReqId += 1);
    aiPending = { reqId, diff, config, pending: new Set(pool), got: [], replies: 0, timer: setTimeout(() => aiTimeout(reqId), AI_TIMEOUT_MS) };
    for (let i = 0; i < pool.length; i++) {
      pool[i]._aiReq = reqId; // so this worker's onerror can name the request it was dispatched for
      pool[i].postMessage({ pieces: game.pieces, turn: game.turn, config: { ...config, slice: { workers: pool.length, index: i } }, reqId });
    }
  } else {
    startAiSlide(applyError(chooseShot(game, config), diff)); // synchronous fallback
  }
}

function frame(now) {
  updateHowto(); // refresh the stage-aware instruction banner
  drawBoard();
  if (mode === 'animating') {
    const rawT = ((now - startedAt) / 1000) * PLAYBACK_RATE;
    const simT = Math.min(rawT, endT); // clamp so the final resting frame stays drawn during the hold
    while (soundIdx + 1 < timeline.length && timeline[soundIdx + 1].t <= simT) {
      soundIdx += 1;
      const snap = timeline[soundIdx];
      if (snap.kind === 'pair' || snap.kind === 'wall') knock(snap.kind, snap.intensity);
    }
    const seg = timeline[soundIdx];
    const dt = simT - seg.t;
    for (const e of seg.bodies) {
      if (e.pocketed) continue;
      const m = meta.get(e.id);
      const p = positionAfter(e.pos, e.vel, dt);
      disc(p.x, p.y, m.radius, COLORS[m.color] ?? COLORS[m.kind]);
    }
    if (rawT >= endT) {
      // all pieces have stopped — hold the final position briefly before resolving the turn
      if (!settleAt) settleAt = now;
      if (now - settleAt >= SETTLE_HOLD_MS) { settleAt = 0; endShot(); }
    }
  } else {
    drawStatic();
    if (mode === 'aiming' && aiSlide) {
      // Watch the computer "operate" the controls, staged so each step is clear:
      //   slide into place → [pause] aim set → charge power → [pause] power set →
      //   [pause] Fire pressed → flick. Each setup part is held for AI_PAUSE (250ms).
      const t = now - aiSlide.startedAt;
      const { shot } = aiSlide;
      const aimDir = Math.cos(shot.angle) >= 0 ? 'right' : 'left'; // which angle button to flag
      const tA = AI_SLIDE_MS; // slide done
      const tB = tA + AI_PAUSE; // aim pause done
      const tC = tB + AI_CHARGE_MS; // power ramp done
      const tD = tC + AI_PAUSE; // power pause done
      const tE = tD + AI_PAUSE; // fire-press pause done → fire

      if (t >= tE) {
        strikerPos = { x: aiSlide.toX, y: aiSlide.y };
        aiSlide = null;
        previewCache = null;
        flick(shot.speed, shot.angle, shot.spin || 0);
      } else {
        // striker position: easing in during the slide, parked thereafter
        if (t < tA) {
          const k = t / AI_SLIDE_MS;
          const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
          strikerPos = { x: aiSlide.fromX + (aiSlide.toX - aiSlide.fromX) * e, y: aiSlide.y };
        } else {
          strikerPos = { x: aiSlide.toX, y: aiSlide.y };
        }
        // power + spin ease up together during the charge stage, then hold at the chosen values
        const ramp = t < tB ? 0 : 1 - (1 - Math.min(1, (t - tB) / AI_CHARGE_MS)) ** 3; // easeOutCubic
        power = ramp * shot.speed;
        const aiSpin = ramp * (shot.spin || 0); // drive the spin slider so the choice is visible
        if (spin !== aiSpin) {
          spin = aiSpin;
          if (spinInput) spinInput.value = String(aiSpin);
          syncSpinLabel();
        }
        // buttons: angle pressed while aiming, Fire pressed during the final beat
        const pressed = t < tB ? aimDir : t >= tD ? 'fire' : null;

        if (t >= tA) drawPreview(now, shot.angle, shot.speed); // planned line (incl. spin), once positioned
        drawStriker();
        drawSlider();
        drawFineButtons({ active: true, pressed });
      }
    } else if (mode === 'aiming') {
      if (adjusting) {
        const dir = (rightHeld ? 1 : 0) - (leftHeld ? 1 : 0);
        if (dir === 0) {
          holdFrames = 0;
          holdDir = 0;
        } else {
          if (dir !== holdDir) { holdFrames = 0; holdDir = dir; } // reset on direction change
          holdFrames += 1;
          const accel = Math.min(ADJUST_ACCEL_MAX, 1 + (holdFrames / ADJUST_RAMP_FRAMES) * (ADJUST_ACCEL_MAX - 1));
          lockedAngle = clampForwardAngle(turnColor(game), lockedAngle + dir * ADJUST_STEP * accel); // stay forward
          previewCache = null; // recompute for the nudged angle
        }
      }
      if (holding || adjusting) drawPreview(now, aimAngleNow(), aimSpeedNow());
      if (dragging) drawBaselineTrack();
      drawStriker();
      drawAim();
      if (!isAiTurn()) { drawSlider(); drawFineButtons(); }
    }
  }
  requestAnimationFrame(frame);
}

function flick(speed, angle, spinAmt = 0) {
  angle = clampForwardAngle(turnColor(game), angle); // enforce the play-forward rule for every shot
  const res = takeShot(game, strikerPos, angle, speed, spinAmt);
  timeline = res.timeline;
  meta = res.meta;
  endT = timeline[timeline.length - 1].t;
  startedAt = performance.now();
  soundIdx = 0; // start of timeline is the 'start' snapshot — no knock
  settleAt = 0; // reset the settle-hold timer for the new shot
  mode = 'animating';
}

function cursorWorld(ev) {
  const rect = canvas.getBoundingClientRect();
  return v.vec(toWorld(((ev.clientX - rect.left) / rect.width) * PX), toWorld(((ev.clientY - rect.top) / rect.height) * PX));
}

// Cursor in canvas pixel space (0..PX) — for the slider, which lives in the margin.
function cursorPx(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - rect.left) / rect.width) * PX, y: ((ev.clientY - rect.top) / rect.height) * PX };
}

// Set power from a slider drag; while fine-tuning, keep the locked shot's power in sync.
function setPowerFromSlider(py) {
  power = yToPower(py);
  if (adjusting) {
    lockedSpeed = power;
    previewCache = null;
  }
}

// Aim toward the cursor, but enforce the "play forward" rule: a backward/sideways drag is
// clamped to the forward limit, and the aim dot snaps there so the line shows the real shot.
function setAimFromCursor(c) {
  const raw = Math.atan2(c.y - strikerPos.y, c.x - strikerPos.x);
  aimAngle = clampForwardAngle(turnColor(game), raw);
  const dist = v.len(v.sub(c, strikerPos));
  aimPoint = { x: strikerPos.x + Math.cos(aimAngle) * dist, y: strikerPos.y + Math.sin(aimAngle) * dist };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType !== 'mouse') ev.preventDefault(); // touch/pen: don't also fire a mouse event
  if (mode === 'gameover') {
    if (game.matchWinner) game = newGame(); // new match
    else nextBoard(game); // next board of the match
    endShot();
    return;
  }
  if (mode !== 'aiming') return;
  if (isAiTurn()) return; // computer's turn — ignore human input
  const px = cursorPx(ev);
  if (onSlider(px.x, px.y)) {
    // adjust power; this does NOT abandon a pending fine-tune (tweak power, then fire)
    sliderDragging = true;
    setPowerFromSlider(px.y);
    return;
  }
  // fine-tune buttons live in the bottom margin while adjusting — check before re-aiming so
  // pressing one doesn't abandon the fine-tune. Angle buttons hold-to-repeat (leftHeld/right
  // Held); Fire/Cancel act on release (handled in mouseup).
  const ftId = ftButtonAt(px.x, px.y);
  if (ftId) {
    ftPressed = ftId;
    if (ftId === 'left') leftHeld = true;
    else if (ftId === 'right') rightHeld = true;
    return;
  }
  const c = cursorWorld(ev);
  adjusting = false; // starting a new aim abandons any pending fine-tune
  if (v.len(v.sub(c, strikerPos)) <= STRIKER.radius) {
    dragging = true;
    return;
  }
  setAimFromCursor(c);
  holding = true;
});

window.addEventListener('pointermove', (ev) => {
  const px = cursorPx(ev);
  // hover feedback for the on-canvas controls (pointer cursor over a button or the slider)
  ftHover = ftButtonAt(px.x, px.y);
  const overCtrl = mode === 'aiming' && !isAiTurn() && onSlider(px.x, px.y);
  canvas.style.cursor = ftHover || overCtrl ? 'pointer' : 'default';

  if (sliderDragging) {
    setPowerFromSlider(px.y);
    return;
  }
  const c = cursorWorld(ev);
  if (dragging) {
    const y = baselineY(turnColor(game));
    strikerPos = { x: legalStrikerX(c.x, y), y };
    return;
  }
  if (holding) {
    // swing the aim while dragging — the preview recomputes for the new (forward) direction
    setAimFromCursor(c);
  }
});

window.addEventListener('pointerup', (ev) => {
  if (ftPressed) {
    const id = ftPressed;
    ftPressed = null;
    leftHeld = rightHeld = false; // stop any angle sweep
    // Fire/Cancel only act if released over the same button (drag off to abort the press)
    if (id === 'fire' || id === 'cancel') {
      const px = cursorPx(ev);
      if (ftButtonAt(px.x, px.y) === id) (id === 'fire' ? fireShot : cancelShot)();
    }
    return;
  }
  if (sliderDragging) {
    sliderDragging = false;
    return;
  }
  if (dragging) {
    dragging = false;
    return;
  }
  if (!holding) return;
  holding = false;
  aimPoint = null;
  if (power > 0) {
    // lock the trajectory and enter fine-tune; fire on Enter (power stays on the slider)
    adjusting = true;
    lockedAngle = aimAngle;
    lockedSpeed = power;
    previewCache = null;
    hud.msg.textContent = 'Fine-tune: ← → angle · slider for power · Enter to fire · Esc to cancel';
  }
});

// A cancelled pointer (touch interrupted by a call, gesture, etc.) must not leave a drag or
// a held angle-nudge stuck on — drop all in-progress interaction state.
window.addEventListener('pointercancel', () => {
  sliderDragging = false;
  dragging = false;
  holding = false;
  aimPoint = null;
  ftPressed = null;
  ftHover = null;
  leftHeld = rightHeld = false;
});

// Fire / cancel the locked-in shot — shared by the keyboard (Enter/Esc) and the on-screen
// fine-tune buttons. Both end the fine-tune phase and clear any held nudge.
function fireShot() {
  if (!adjusting) return;
  adjusting = false;
  leftHeld = rightHeld = false;
  flick(lockedSpeed, lockedAngle, spin);
}
function cancelShot() {
  if (!adjusting) return;
  adjusting = false;
  leftHeld = rightHeld = false;
  updateHud();
}

// Fine-tune controls: arrows nudge the angle (hold for continuous), Enter fires, Esc cancels.
window.addEventListener('keydown', (ev) => {
  if (!adjusting) return;
  if (ev.key === 'ArrowLeft') { leftHeld = true; ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { rightHeld = true; ev.preventDefault(); }
  else if (ev.key === 'Enter') { ev.preventDefault(); fireShot(); }
  else if (ev.key === 'Escape') { ev.preventDefault(); cancelShot(); }
});

window.addEventListener('keyup', (ev) => {
  if (ev.key === 'ArrowLeft') leftHeld = false;
  else if (ev.key === 'ArrowRight') rightHeld = false;
});

// Toggling self-play kicks off the AI for the current turn if it's idle.
document.getElementById('selfplay').addEventListener('change', () => {
  if (isAiTurn() && mode === 'aiming') endShot();
});

// Unlock audio on the first user gesture anywhere (browser autoplay policy).
for (const e of ['pointerdown', 'keydown']) window.addEventListener(e, unlockAudio);

updateHud();
requestAnimationFrame(frame);
if (isAiTurn()) endShot(); // auto-start self-play from the opening break
