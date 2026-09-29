// Repeatable heavy motion for A/B tests: fling the map (or any scrollable screen) back and forth.
//   node fling.mjs <engine-port> <seconds>
// Joins the engine as a paused viewer (no video) and sends touch drags only.
import { WebSocket } from 'ws';

const [PORT = '8811', SECS = '20'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream`);
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ t: 'pause' }));
const touch = (p, x, y) => ws.send(JSON.stringify({ t: 'touch', p, x, y, edge: 0 }));

const end = Date.now() + Number(SECS) * 1000;
let n = 0;
while (Date.now() < end) {
  // Alternate diagonal flings: 12 moves over ~100 ms, release at speed so the map keeps coasting.
  const [x0, y0, x1, y1] = n++ % 2 ? [0.8, 0.65, 0.2, 0.35] : [0.2, 0.35, 0.8, 0.65];
  touch('down', x0, y0);
  for (let i = 1; i <= 12; i++) {
    await sleep(8);
    touch('move', x0 + ((x1 - x0) * i) / 12, y0 + ((y1 - y0) * i) / 12);
  }
  touch('up', x1, y1);
  await sleep(350);
}
ws.close();
