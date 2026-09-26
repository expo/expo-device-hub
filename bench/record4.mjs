// Joins as a viewer, saves the received H.264 stream verbatim (Annex B) with arrival times,
// and drives the demo gestures over the same connection.
import { openSync, writeSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
const [URL, OUT] = process.argv.slice(2);
const steps = JSON.parse(readFileSync('/tmp/demo-steps.json', 'utf8')).filter((s) => s.op !== 'shot');
const fd = openSync(OUT + '.h264', 'w'); const arrivals = []; let configs = 0, started = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const START = Buffer.from([0, 0, 0, 1]);
const ws = new WebSocket(URL.replace(/^http/, 'ws').replace(/\/?$/, '/stream')); ws.binaryType = 'arraybuffer';
ws.onmessage = (e) => {
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data); if (m.t !== 'config') return;
    const c = Buffer.from(m.description, 'base64');   // avcC: SPS/PPS
    let o = 5; const nSps = c[o++] & 0x1f;
    for (let i = 0; i < nSps; i++) { const l = c.readUInt16BE(o); o += 2; writeSync(fd, START); writeSync(fd, c.subarray(o, o + l)); o += l; }
    const nPps = c[o++];
    for (let i = 0; i < nPps; i++) { const l = c.readUInt16BE(o); o += 2; writeSync(fd, START); writeSync(fd, c.subarray(o, o + l)); o += l; }
    configs++; return;
  }
  const b = Buffer.from(e.data); const seq = b.readUInt32LE(1);
  ws.send(JSON.stringify({ t: 'ack', seq }));
  if (!configs) return;
  arrivals.push(performance.now());
  for (let o = 25; o < b.length;) { const l = b.readUInt32BE(o); o += 4; writeSync(fd, START); writeSync(fd, b.subarray(o, o + l)); o += l; }
};
ws.onopen = async () => {
  let seq = 980000; const t = (p, x, y, edge = 0) => ws.send(JSON.stringify({ t: 'touch', p, x, y, seq: ++seq, edge }));
  await sleep(1500);
  for (const s of steps) {
    if (s.op === 'tap') { t('down', s.x, s.y); await sleep(70); t('up', s.x, s.y); }
    if (s.op === 'swipe') { const e = s.edge || 0; t('down', s.x0, s.y0, e); for (let k = 1; k <= 14; k++) { await sleep(16); t('move', s.x0 + (s.x1 - s.x0) * k / 14, s.y0 + (s.y1 - s.y0) * k / 14, e); } await sleep(16); t('up', s.x1, s.y1, e); }
    await sleep(s.wait ?? s.ms ?? 0);
  }
  closeSync(fd);
  const iv = arrivals.slice(1).map((x, i) => x - arrivals[i]); const m = iv.reduce((a, b) => a + b, 0) / iv.length;
  const sd = Math.sqrt(iv.reduce((a, b) => a + (b - m) ** 2, 0) / iv.length);
  console.log(`received ${arrivals.length} frames in ${((arrivals.at(-1) - arrivals[0]) / 1000).toFixed(1)} s: ${(1000 / m).toFixed(1)} fps, arrival spacing ${m.toFixed(1)} ±${sd.toFixed(1)} ms, gaps >25 ms: ${iv.filter((x) => x > 25).length}`);
  process.exit(0);
};
