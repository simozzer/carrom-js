// renderer.js — 2-player Carrom: board, turn flow, aiming, and timeline replay.
// Serve from the PROJECT ROOT (npm run serve) and open /web/ — file:// blocks ES imports.
//
// A turn: drag the striker along the current player's baseline, then press & hold the
// border to aim and charge, release to flick. Pocket your own men to keep playing; the
// rules (continuation, fouls, queen cover, win) live in src/game.js.

import { BOARD, walls, pockets, PUCK, QUEEN, STRIKER } from '../src/board.js';
import { positionAfter } from '../src/body.js';
import { newGame, nextBoard, takeShot, shotBodies, turnColor, baselineY, strikerHome, BASE_HALF, BASE_CIRCLE_R, strikerXLimit } from '../src/game.js';
import { simulate } from '../src/simulate.js';
import { chooseShot, applyError } from '../src/ai.js';
import * as v from '../src/vec2.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const PX = canvas.width;

const MARGIN = 70;
const INNER = PX - 2 * MARGIN;
const toPx = (m) => MARGIN + (m / BOARD.size + 0.5) * INNER;
const scalePx = (m) => (m / BOARD.size) * INNER;
const toWorld = (px) => ((px - MARGIN) / INNER - 0.5) * BOARD.size;

const COLORS = { white: '#f3ead3', black: '#525a63', queen: '#b03030', striker: '#37306b' };

const ARM_DELAY = 200; // ms before charge starts
const CHARGE_MS = 1500; // ms from zero to full power
const MAX_SPEED = 6.0; // m/s at full charge
const PLAYBACK_RATE = 0.6; // <1 plays the shot back slower than real time
// Trajectory-depth menu: how many collisions the preview looks ahead (0 = off).
const TRAJECTORY = { none: 0, immediate: 2, full: 30 };
const trajectoryDepth = () => TRAJECTORY[document.getElementById('trajectory')?.value] ?? TRAJECTORY.full;
const FAN_LINES = 4; // perturbed paths each side of the aim (uncertainty fan)
const FAN_HALF_ANGLE = 0.07; // ~4° half-spread for the fan
const FAN_EVENTS = 1; // fan paths drawn up to first contact (cheap + most telling)
const PREVIEW_REFRESH_MS = 40; // recompute throttle (analytic solver is cheap → responsive)

let game = newGame();
let mode = 'aiming'; // 'aiming' | 'animating' | 'gameover'
let strikerPos = strikerHome(turnColor(game));

const selfPlay = () => document.getElementById('selfplay')?.checked;

// Difficulty = how much execution error the AI gets (perfect = none = hardest).
const DIFFICULTY = {
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
const AI_HOLD_MS = 400; // show the planned trajectory at the start position before firing

// replay state
let timeline = [];
let meta = new Map();
let endT = 0;
let startedAt = 0;
let soundIdx = 0; // index of the last collision whose knock has played

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
function knock(kind) {
  // stay silent until audio has been unlocked by a gesture and is actually running
  if (!soundOn() || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const ctx = audioCtx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    const base = kind === 'wall' ? 200 : 330; // cushion duller than puck/puck
    o.frequency.value = base * (0.92 + Math.random() * 0.16); // slight variation per hit
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(kind === 'wall' ? 0.18 : 0.22, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.09);
  } catch {
    /* no audio device available — play silently */
  }
}

// interaction state
let aiSlide = null; // AI: { fromX, toX, y, startedAt, shot } while sliding the striker into place
let dragging = false;
let holding = false;
let pressAt = 0;
let aimAngle = 0;
let aimPoint = null;
let previewCache = null; // { main: Map<id, pts[]>, fan: pts[][] }
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

// effective aim used by the preview/gauge: locked while adjusting, live while charging
const aimAngleNow = () => (adjusting ? lockedAngle : aimAngle);
const aimSpeedNow = (now) => (adjusting ? lockedSpeed : chargeSpeed(now));

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
    : `Board ${game.boards + 1} · first to ${game.target}`;
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

// Power oscillates: ramp 0 -> max over CHARGE_MS, then max -> 0, repeating. You time
// your release for the power you want; release at the trough (speed 0) to cancel and
// re-plan. Never stuck pinned at max.
function chargeSpeed(now) {
  const held = now - pressAt;
  if (held <= ARM_DELAY) return 0;
  const cycle = ((held - ARM_DELAY) % (2 * CHARGE_MS)) / CHARGE_MS; // 0..2
  const frac = cycle <= 1 ? cycle : 2 - cycle; // triangle wave 0..1..0
  return frac * MAX_SPEED;
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
  return simulate({ bodies }, { strikerId: 'striker', angle, speed }, { maxEvents }).timeline;
}

// Recompute the exact path + the perturbed-aim fan (throttled; cached between).
function computePreview(angle, speed, now) {
  const main = pathsFromTimeline(lookAhead(angle, speed, trajectoryDepth()));
  const fan = [];
  for (let i = -FAN_LINES; i <= FAN_LINES; i++) {
    if (i === 0) continue;
    const tl = lookAhead(angle + (i / FAN_LINES) * FAN_HALF_ANGLE, speed, FAN_EVENTS);
    fan.push(tl.map((s) => s.bodies.find((b) => b.id === 'striker').pos));
  }
  previewCache = { main, fan };
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
  // uncertainty fan — faint striker spread under slightly perturbed aim
  ctx.strokeStyle = 'rgba(40, 40, 90, 0.16)';
  ctx.lineWidth = 1;
  for (const pts of previewCache.fan) if (pts.length > 1) polyline(pts);

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

function drawAim(now) {
  if (!holding && !adjusting) return;
  // power gauge (blue once locked for fine-tuning)
  const frac = aimSpeedNow(now) / MAX_SPEED;
  const x = toPx(walls().minX);
  const y = PX - MARGIN / 2 - 6;
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x, y, scalePx(BOARD.size), 12);
  ctx.fillStyle = adjusting ? '#2e6da4' : frac >= 1 ? '#c0392b' : '#2e8b57';
  ctx.fillRect(x, y, scalePx(BOARD.size) * frac, 12);
  // cursor aim line only while actively dragging the aim
  if (holding && aimPoint) {
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

function aiMove() {
  if (!isAiTurn() || mode !== 'aiming') return;
  // pick the best shot (with difficulty error), then slide the striker into place
  // before firing so the user can see the start position
  const shot = applyError(chooseShot(game, { maxEvents: 25 }), difficulty());
  const toX = legalStrikerX(shot.strikerPos.x, shot.strikerPos.y);
  aiSlide = { fromX: strikerPos.x, toX, y: shot.strikerPos.y, startedAt: performance.now(), shot };
  previewCache = null; // fresh preview for the AI's chosen line
}

function frame(now) {
  drawBoard();
  if (mode === 'animating') {
    const simT = ((now - startedAt) / 1000) * PLAYBACK_RATE;
    if (simT >= endT) {
      endShot();
    } else {
      while (soundIdx + 1 < timeline.length && timeline[soundIdx + 1].t <= simT) {
        soundIdx += 1;
        const kind = timeline[soundIdx].kind;
        if (kind === 'pair' || kind === 'wall') knock(kind);
      }
      const seg = timeline[soundIdx];
      const dt = simT - seg.t;
      for (const e of seg.bodies) {
        if (e.pocketed) continue;
        const m = meta.get(e.id);
        const p = positionAfter(e.pos, e.vel, dt);
        disc(p.x, p.y, m.radius, COLORS[m.color] ?? COLORS[m.kind]);
      }
    }
  } else {
    drawStatic();
    if (mode === 'aiming' && aiSlide) {
      // animate the AI striker to its start position, hold, then fire
      const t = now - aiSlide.startedAt;
      if (t < AI_SLIDE_MS) {
        const k = t / AI_SLIDE_MS;
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
        strikerPos = { x: aiSlide.fromX + (aiSlide.toX - aiSlide.fromX) * e, y: aiSlide.y };
        drawStriker();
      } else if (t < AI_SLIDE_MS + AI_HOLD_MS) {
        strikerPos = { x: aiSlide.toX, y: aiSlide.y };
        drawPreview(now, aiSlide.shot.angle, aiSlide.shot.speed); // show the planned line before firing
        drawStriker();
      } else {
        const { shot } = aiSlide;
        strikerPos = { x: aiSlide.toX, y: aiSlide.y };
        aiSlide = null;
        previewCache = null;
        flick(shot.speed, shot.angle);
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
          lockedAngle += dir * ADJUST_STEP * accel;
          previewCache = null; // recompute for the nudged angle
        }
      }
      if (holding || adjusting) drawPreview(now, aimAngleNow(), aimSpeedNow(now));
      if (dragging) drawBaselineTrack();
      drawStriker();
      drawAim(now);
    }
  }
  requestAnimationFrame(frame);
}

function flick(speed, angle) {
  const res = takeShot(game, strikerPos, angle, speed);
  timeline = res.timeline;
  meta = res.meta;
  endT = timeline[timeline.length - 1].t;
  startedAt = performance.now();
  soundIdx = 0; // start of timeline is the 'start' snapshot — no knock
  mode = 'animating';
}

function cursorWorld(ev) {
  const rect = canvas.getBoundingClientRect();
  return v.vec(toWorld(((ev.clientX - rect.left) / rect.width) * PX), toWorld(((ev.clientY - rect.top) / rect.height) * PX));
}

canvas.addEventListener('mousedown', (ev) => {
  if (mode === 'gameover') {
    if (game.matchWinner) game = newGame(); // new match
    else nextBoard(game); // next board of the match
    endShot();
    return;
  }
  if (mode !== 'aiming') return;
  if (isAiTurn()) return; // computer's turn — ignore human input
  const c = cursorWorld(ev);
  adjusting = false; // starting a new aim abandons any pending fine-tune
  if (v.len(v.sub(c, strikerPos)) <= STRIKER.radius) {
    dragging = true;
    return;
  }
  aimPoint = c;
  aimAngle = Math.atan2(c.y - strikerPos.y, c.x - strikerPos.x);
  pressAt = performance.now();
  holding = true;
});

window.addEventListener('mousemove', (ev) => {
  const c = cursorWorld(ev);
  if (dragging) {
    const y = baselineY(turnColor(game));
    strikerPos = { x: legalStrikerX(c.x, y), y };
    return;
  }
  if (holding) {
    // swing the aim while charging — the preview/fan recompute for the new direction
    aimPoint = c;
    aimAngle = Math.atan2(c.y - strikerPos.y, c.x - strikerPos.x);
  }
});

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    return;
  }
  if (!holding) return;
  holding = false;
  const speed = chargeSpeed(performance.now());
  aimPoint = null;
  if (speed > 0) {
    // lock the trajectory and enter fine-tune; fire on Enter
    adjusting = true;
    lockedAngle = aimAngle;
    lockedSpeed = speed;
    previewCache = null;
    hud.msg.textContent = 'Fine-tune: ← → adjust angle · Enter to fire · Esc to cancel';
  }
});

// Fine-tune controls: arrows nudge the angle (hold for continuous), Enter fires, Esc cancels.
window.addEventListener('keydown', (ev) => {
  if (!adjusting) return;
  if (ev.key === 'ArrowLeft') { leftHeld = true; ev.preventDefault(); }
  else if (ev.key === 'ArrowRight') { rightHeld = true; ev.preventDefault(); }
  else if (ev.key === 'Enter') {
    ev.preventDefault();
    adjusting = false;
    leftHeld = rightHeld = false;
    flick(lockedSpeed, lockedAngle);
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    adjusting = false;
    leftHeld = rightHeld = false;
    updateHud();
  }
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
