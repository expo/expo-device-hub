// Drives the transitions users see artifacts on: swipe home, app switcher, back, plus list drags.
import { execSync } from 'node:child_process';
const port = process.argv[2];
const ws = new WebSocket(`ws://localhost:${port}/stream`); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => { ws.send(JSON.stringify({ t: 'pause' })); let seq = 1; const t = (p, x, y, e = 0) => ws.send(JSON.stringify({ t: 'touch', p, x, y, seq: seq++, edge: e }));
  const drag = async (x0, y0, x1, y1, e = 0, steps = 16, hold = 0) => { t('down', x0, y0, e); for (let k = 1; k <= steps; k++) { await sleep(16); t('move', x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, e); } if (hold) await sleep(hold); await sleep(16); t('up', x1, y1, e); };
  for (let round = 0; round < 2; round++) {
    execSync('xcrun simctl launch booted com.apple.Preferences'); await sleep(1200);
    await drag(0.5, 0.75, 0.5, 0.3); await sleep(700); await drag(0.5, 0.3, 0.5, 0.8); await sleep(700);
    await drag(0.5, 0.999, 0.5, 0.45, 3); await sleep(1200);                 // home
    execSync('xcrun simctl launch booted com.apple.Preferences'); await sleep(1200);
    await drag(0.5, 0.999, 0.5, 0.62, 3, 24, 450); await sleep(1300);        // app switcher (slow, hold)
    t('down', 0.5, 0.4); await sleep(70); t('up', 0.5, 0.4); await sleep(1200); // back into the app
  }
  process.exit(0); };
