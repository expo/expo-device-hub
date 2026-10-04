// Scrolls by dragging: one input socket, 20 drags 3 s apart, each 0.8 → 0.3 or back over 300 ms at 60 Hz.
//   node drag.mjs <udid>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(join(process.env.REPO, "packages/serve-sim/packages/serve-sim/package.json"));
const WebSocket = require("ws");
const state = JSON.parse(readFileSync(join(tmpdir(), "serve-sim", `server-${process.argv[2]}.json`), "utf8"));
const ws = new WebSocket(state.wsUrl, state.token ? { headers: { Authorization: `Bearer ${state.token}` } } : undefined);
await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (type, y) => {
  const json = new TextEncoder().encode(JSON.stringify({ type, x: 0.5, y }));
  const msg = new Uint8Array(1 + json.length);
  msg[0] = 0x03;
  msg.set(json, 1);
  ws.send(msg);
};
const start = Date.now();
for (let i = 0; i < 20; i++) {
  const [from, to] = i % 2 === 0 ? [0.8, 0.3] : [0.3, 0.8];
  send("begin", from);
  for (let step = 1; step <= 18; step++) {
    await sleep(1000 / 60);
    send("move", from + ((to - from) * step) / 18);
  }
  send("end", to);
  await sleep(Math.max(0, start + 3000 * (i + 1) - Date.now()));
}
ws.close();
