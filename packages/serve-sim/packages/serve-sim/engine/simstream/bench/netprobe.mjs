// Connects like a viewer, acks every frame on arrival, and reports frame delivery over a window.
const [url, warmupS = '4', seconds = '12'] = process.argv.slice(2);
const ws = new WebSocket(url.replace(/^http/, 'ws').replace(/\/?$/, '/stream')); ws.binaryType = 'arraybuffer';
const arrivals = [], latency = [], rtts = []; let bytes = 0, offset = null, bestRtt = Infinity, target = 0, measuring = false;
ws.onmessage = (e) => {
  const now = performance.now();
  if (typeof e.data === 'string') {
    const m = JSON.parse(e.data);
    if (m.t === 'pong') { const rtt = now - m.ts; if (measuring) rtts.push(rtt); if (rtt < bestRtt) { bestRtt = rtt; offset = m.server - (m.ts + now) / 2; } }
    if (m.t === 'stats' && measuring) target = m.bitrate;
    return;
  }
  const v = new DataView(e.data);
  ws.send(JSON.stringify({ t: 'ack', seq: v.getUint32(1, true) }));
  if (!measuring) return;
  arrivals.push(now); bytes += e.data.byteLength;
  if (offset !== null) latency.push(now - (v.getFloat64(5, true) - offset));
};
ws.onopen = () => setInterval(() => ws.send(JSON.stringify({ t: 'ping', ts: performance.now() })), 200);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
setTimeout(() => { measuring = true; }, Number(warmupS) * 1000);
setTimeout(() => {
  const iv = arrivals.slice(1).map((t, i) => t - arrivals[i]);
  const mean = iv.reduce((a, b) => a + b, 0) / iv.length, sd = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length);
  console.log(JSON.stringify({
    fps: +(arrivals.length / Number(seconds)).toFixed(1),
    interval: `${mean.toFixed(1)}±${sd.toFixed(1)} ms (p95 ${q(iv, 0.95).toFixed(1)}, max ${Math.max(...iv).toFixed(0)})`,
    stalls: iv.filter((x) => x > 50).length,
    mbps: +(bytes * 8 / Number(seconds) / 1e6).toFixed(2), targetMbps: +(target / 1e6).toFixed(1),
    rtt: `${q(rtts, 0.5).toFixed(1)} ms (p95 ${q(rtts, 0.95).toFixed(1)})`,
    captureToArrival: `${q(latency, 0.5).toFixed(1)} ms (p95 ${q(latency, 0.95).toFixed(1)})`,
  }));
  process.exit(0);
}, (Number(warmupS) + Number(seconds)) * 1000);
