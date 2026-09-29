// Play a route (the recorder's step format) straight into the simulator through the simstream
// engine's input, with no viewer: for calibrating gestures and resetting state between recordings.
//   node gest.mjs <engine-port> <route.json | inline JSON>
// Steps: { op: 'wait', ms } | { op: 'tap', x, y } | { op: 'swipe', x0, y0, x1, y1 } |
//        { op: 'path', pts: [[ms, x, y], ...] } (press at the first point, release at the last) |
//        { op: 'button', b: 'home' | 'lock' }; any step may add wait (ms after it).
import { readFileSync, existsSync } from 'node:fs';
import { WebSocket } from 'ws';

const [PORT = '8811', ROUTE] = process.argv.slice(2);
const steps = JSON.parse(existsSync(ROUTE) ? readFileSync(ROUTE, 'utf8') : ROUTE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream`);
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ t: 'pause' }));
const touch = (p, x, y) => ws.send(JSON.stringify({ t: 'touch', p, x, y, edge: 0 }));

const t0 = performance.now();
const until = (ms) => sleep(Math.max(0, t0 + ms - performance.now()));
let at = 0;
for (const s of steps) {
  if (s.op === 'wait') { at += s.ms; continue; }
  await until(at);
  if (s.op === 'tap') { touch('down', s.x, s.y); await until(at + 60); touch('up', s.x, s.y); at += 60; }
  if (s.op === 'swipe') {
    touch('down', s.x0, s.y0);
    for (let k = 1; k <= 14; k++) { await until(at + 16 * k); touch('move', s.x0 + (s.x1 - s.x0) * k / 14, s.y0 + (s.y1 - s.y0) * k / 14); }
    await until(at + 240); touch('up', s.x1, s.y1); at += 240;
  }
  if (s.op === 'path') {
    const [[, x0, y0], ...rest] = s.pts;
    touch('down', x0, y0);
    for (const [ms, x, y] of rest) { await until(at + ms); touch('move', x, y); }
    const [ms, x, y] = s.pts[s.pts.length - 1];
    await until(at + ms); touch('up', x, y); at += ms;
  }
  if (s.op === 'button') {
    ws.send(JSON.stringify({ t: 'button', b: s.b, down: true })); await until(at + 80);
    ws.send(JSON.stringify({ t: 'button', b: s.b, down: false })); at += 80;
  }
  at += s.wait || 0;
}
await until(at);
ws.close();
