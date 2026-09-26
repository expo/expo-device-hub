// Real browser viewer + real pointer drags; prints the per-stage latency waterfall.
import { spawn } from 'node:child_process';
const [URL, SECONDS = '10', LABEL = ''] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9342', '--user-data-dir=/tmp/simstream-chrome-lat', '--window-size=1100,900', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 50; i++) { try { t = await (await fetch('http://127.0.0.1:9342/json')).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
try {
  await cdp('Page.navigate', { url: URL }); await sleep(3500);
  const r = await ev(`(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const m = (type, fx, fy) => cdp('Input.dispatchMouseEvent', { type, x: r.x + r.w * fx, y: r.y + r.h * fy, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const samples = [];
  const end = Date.now() + Number(SECONDS) * 1000; let dir = 1, lastSample = Date.now();
  while (Date.now() < end) {
    // slow drags: continuous finger-follow scrolling, one input per frame
    const [a, b] = dir > 0 ? [0.75, 0.35] : [0.35, 0.75]; dir = -dir;
    await m('mousePressed', 0.5, a);
    for (let i = 1; i <= 30; i++) { await sleep(16); await m('mouseMoved', 0.5, a + (b - a) * i / 30); }
    await m('mouseReleased', 0.5, b); await sleep(250);
    if (Date.now() - lastSample > 1000) { const L = await ev('window.simstreamLatency'); if (L) samples.push(L); lastSample = Date.now(); }
  }
  const keys = ['up', 'ios', 'queue', 'encode', 'send', 'network', 'decode', 'draw', 'total', 'present', 'touch'];
  const names = { up: 'network ↑', ios: 'iOS→captured', queue: 'capture→encoder', encode: 'encode', send: 'encoded→sent', network: 'network ↓', decode: 'decode', draw: 'draw', total: 'capture→drawn', present: '→next frame', touch: 'touch→drawn' };
  const agg = (k, f) => { const v = samples.map((s) => s[k]?.[f]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
  console.log(`${LABEL}  (rtt ${agg('rtt') || samples.at(-1)?.rtt?.toFixed?.(1)} ms, ${samples.length} windows)`);
  for (const k of keys) console.log(`  ${names[k].padEnd(16)} ${agg(k, 'mean').toFixed(1).padStart(6)}  p95 ${agg(k, 'p95').toFixed(1).padStart(6)}`);
} finally { ws.close(); chrome.kill(); }
