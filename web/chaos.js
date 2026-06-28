// chaos.js — fractal basin-boundary map for the carrom engine.
//
// Each pixel is one shot (x = aim angle, y = power) fired into a fixed rack. We simulate it to
// rest and colour by the OUTCOME: hue from the set of pocketed pieces (striker included, so a
// scratch gets its own colour), brightness from the collision count. Neighbouring outcomes are
// usually identical — until you cross a basin boundary, where a vanishing change in aim flips
// the whole result. Those boundaries are fractal: the signature of sensitive dependence.
//
// The engine is exact (analytic event prediction), so this structure is the system's, not a
// time-stepping artefact.

import { Body } from '../src/body.js';
import { simulate } from '../src/simulate.js';
import { PUCK, STRIKER, QUEEN } from '../src/board.js';
import { vec } from '../src/vec2.js';

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const readout = document.getElementById('readout');
const resSel = document.getElementById('resolution');
const spanSel = document.getElementById('span');
const renderBtn = document.getElementById('render');
const stopBtn = document.getElementById('stop');
const loA = document.getElementById('loA');
const hiA = document.getElementById('hiA');

const SP_MIN = 2.5, SP_MAX = 6.0; // power band
const MAX_EVENTS = 400; // safety cap per shot (rack settles in ~41 events; this is headroom)
let angMin = Math.PI / 2 - 0.6, angMax = Math.PI / 2 + 0.6;

// Fixed rack: a red queen at centre ringed by six men; striker on the bottom baseline. Fresh
// bodies per shot because the engine mutates them.
function makeBodies() {
  const b = [
    new Body({ id: 'q', kind: 'queen', pos: vec(0, 0), radius: QUEEN.radius, mass: QUEEN.mass }),
  ];
  const n = 6, r = 2.4 * PUCK.radius;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 2 * Math.PI;
    b.push(new Body({ id: 'm' + k, kind: 'man', pos: vec(Math.cos(a) * r, Math.sin(a) * r), radius: PUCK.radius, mass: PUCK.mass }));
  }
  b.push(new Body({ id: 'striker', kind: 'striker', pos: vec(0, -0.25), radius: STRIKER.radius, mass: STRIKER.mass }));
  return b;
}

function shoot(angle, speed) {
  return simulate({ bodies: makeBodies() }, { strikerId: 'striker', angle, speed }, { maxEvents: MAX_EVENTS, timeline: false });
}

// FNV-1a string hash -> 0..359 hue. Distinct outcome-sets get distinct (stable) hues.
function hashHue(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 360;
}

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function outcomeColor(res) {
  const pk = res.pocketed;
  const ev = res.events;
  if (pk.length === 0) {
    // no capture — dark blue, faint texture by collision count
    return hslToRgb(222, 30, 6 + Math.min(22, ev * 0.7));
  }
  const hue = hashHue(pk.slice().sort().join(','));
  const scratch = pk.includes('striker');
  return hslToRgb(hue, scratch ? 38 : 80, 30 + Math.min(40, ev * 0.9));
}

const angleOf = (x, W) => angMin + (x / (W - 1)) * (angMax - angMin);
const speedOf = (y, H) => SP_MAX - (y / (H - 1)) * (SP_MAX - SP_MIN);

let running = false;

function setBusy(b) {
  running = b;
  renderBtn.disabled = b;
  stopBtn.disabled = !b;
  resSel.disabled = b;
  spanSel.disabled = b;
}

function render() {
  const N = Number(resSel.value);
  const half = Number(spanSel.value);
  angMin = Math.PI / 2 - half;
  angMax = Math.PI / 2 + half;
  loA.textContent = `${Math.round((angMin - Math.PI / 2) * 180 / Math.PI)}°`;
  hiA.textContent = `+${Math.round((angMax - Math.PI / 2) * 180 / Math.PI)}°`;

  canvas.width = N;
  canvas.height = N;
  const img = ctx.createImageData(N, N);
  const data = img.data;
  const total = N * N;
  const distinct = new Set();
  let idx = 0;
  const t0 = performance.now();
  setBusy(true);

  function chunk() {
    if (!running) { finish('stopped'); return; }
    const frameStart = performance.now();
    while (idx < total && performance.now() - frameStart < 25) {
      const x = idx % N, y = (idx / N) | 0;
      const res = shoot(angleOf(x, N), speedOf(y, N));
      const p = idx * 4;
      const [r, g, b] = outcomeColor(res);
      data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255;
      distinct.add(res.pocketed.slice().sort().join(','));
      idx++;
    }
    ctx.putImageData(img, 0, 0);
    const pct = ((100 * idx) / total).toFixed(0);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    status.textContent = `${pct}% · ${idx.toLocaleString()}/${total.toLocaleString()} shots · ${distinct.size} distinct outcomes · ${secs}s`;
    if (idx < total) requestAnimationFrame(chunk);
    else finish(`done · ${distinct.size} distinct outcomes · ${secs}s`);
  }
  function finish(tail) {
    setBusy(false);
    status.textContent = status.textContent.replace(/^\d+%/, '100%') + (tail.startsWith('done') ? '' : ` · ${tail}`);
  }
  requestAnimationFrame(chunk);
}

renderBtn.addEventListener('click', render);
stopBtn.addEventListener('click', () => { running = false; });

// Click a pixel to inspect that exact shot.
canvas.addEventListener('click', (ev) => {
  const rect = canvas.getBoundingClientRect();
  const N = canvas.width;
  const x = Math.min(N - 1, Math.max(0, Math.floor(((ev.clientX - rect.left) / rect.width) * N)));
  const y = Math.min(N - 1, Math.max(0, Math.floor(((ev.clientY - rect.top) / rect.height) * N)));
  const angle = angleOf(x, N), speed = speedOf(y, N);
  const res = shoot(angle, speed);
  const deg = ((angle - Math.PI / 2) * 180 / Math.PI).toFixed(1);
  const pots = res.pocketed.length ? res.pocketed.join(', ') : 'nothing';
  readout.textContent = `aim ${deg >= 0 ? '+' : ''}${deg}° · power ${speed.toFixed(2)} → potted: ${pots} · ${res.events} collisions${res.pocketed.includes('striker') ? ' · SCRATCH' : ''}`;
});

// initial labels
loA.textContent = `${Math.round((angMin - Math.PI / 2) * 180 / Math.PI)}°`;
hiA.textContent = `+${Math.round((angMax - Math.PI / 2) * 180 / Math.PI)}°`;
