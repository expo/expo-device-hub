// Original 20 alternating drags at 3 s intervals, with portable dependency/state lookup.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (!process.env.REPO || !process.env.SERVE_SIM_STATE_DIR) throw new Error('Set REPO and SERVE_SIM_STATE_DIR');
const require = createRequire(join(process.env.REPO, 'packages/serve-sim/packages/serve-sim/package.json'));
const WebSocket = require('ws');
const state = JSON.parse(readFileSync(join(process.env.SERVE_SIM_STATE_DIR, `server-${process.argv[2]}.json`), 'utf8'));
const ws = new WebSocket(state.wsUrl, state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined);
// Unlike the old harness, wait for actual input admission rather than open alone.
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { ws.terminate(); reject(new Error('Input admission timed out')); }, 5000);
  ws.on('message', data => { if (data[0] === 0x83) { clearTimeout(timer); resolve(); } });
  ws.once('error', err => { clearTimeout(timer); reject(err); });
  ws.once('close', code => { clearTimeout(timer); reject(new Error(`Closed before admission: ${code}`)); });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const send = (type, y) => {
  const json = new TextEncoder().encode(JSON.stringify({ type, x: 0.5, y }));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = 0x03;
  msg.set(json, 1);
  ws.send(msg);
};
try {
  const start = Date.now();
  for (let i = 0; i < 20; i++) {
    const [from, to] = i % 2 === 0 ? [0.8, 0.3] : [0.3, 0.8];
    send('begin', from);
    for (let step = 1; step <= 18; step++) {
      await sleep(1000 / 60);
      send('move', from + ((to - from) * step) / 18);
    }
    send('end', to);
    await sleep(Math.max(0, start + 3000 * (i + 1) - Date.now()));
  }
} finally { ws.close(); }
