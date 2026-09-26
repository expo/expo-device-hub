const [url, mode, hevc, ms] = process.argv.slice(2);
const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
let offset = null, best = Infinity; const arr = [], lat = [];
ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', codecs: ['hevc', 'h264'] })); ws.send(JSON.stringify({ t: 'settings', transitions: mode, hevc: hevc === 'hevc' })); setInterval(() => ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 200); };
ws.onmessage = (e) => { const now = performance.now();
  if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'pong') { const r = now - m.ts; if (r < best) { best = r; offset = m.server - (m.ts + now) / 2; } } return; }
  const v = new DataView(e.data); ws.send(JSON.stringify({ t: 'ack', seq: v.getUint32(1, true) })); arr.push(now); if (offset !== null) lat.push(now - (v.getFloat64(5, true) - offset)); };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
setTimeout(() => { const iv = arr.slice(1).map((t, i) => t - arr[i]).filter((x) => x < 100);
  console.log(`   arrival: ${(1000 * iv.length / iv.reduce((a, b) => a + b, 0)).toFixed(0)} fps in motion, gaps>50ms ${arr.slice(1).map((t, i) => t - arr[i]).filter((x) => x > 50 && x < 1000).length}, capture→arrival median ${q(lat, 0.5).toFixed(0)} ms p95 ${q(lat, 0.95).toFixed(0)} ms`); process.exit(0); }, Number(ms));
