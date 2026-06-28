// ai-worker.js — runs the AI's shot search off the main thread so the (up to ~0.5s) think
// doesn't freeze the UI. It receives a minimal game snapshot ({ pieces, turn }) plus the
// search config and returns the chosen shot; the execution-error wobble is applied back on
// the main thread. chooseShot only reads game.pieces and game.turn, both structured-cloneable.
import { chooseShot } from '../src/ai.js';

self.onmessage = (e) => {
  const { pieces, turn, config, reqId } = e.data;
  const shot = chooseShot({ pieces, turn }, config);
  self.postMessage({ shot, reqId });
};
