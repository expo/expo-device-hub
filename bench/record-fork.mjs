// Viewer-side recording of a scripted route: at every display refresh, draw what the viewer page is
// showing (video or canvas, at its intrinsic resolution) into a captioned canvas and encode it with
// WebCodecs, one output frame per refresh, so freezes and skipped frames show up as they would on
// screen. Input is driven through the page itself (CDP mouse events on the simulator view).
//
// node record-fork.mjs URL "LABEL" OUT_BASENAME route|barcode [PORT]
//   route:   runs route-fork.json (from the home screen); barcode: records 20 s of the clock page with
//            its measured display latency in the caption.
// Writes OUT_BASENAME.h264 (60 fps Annex B) and OUT_BASENAME.json (start frame, refresh gaps, stats).
import { spawn } from 'node:child_process';
import { writeFileSync, createWriteStream, readFileSync } from 'node:fs';
const [URL, LABEL, OUT, MODE = 'route', PORT = '9370'] = process.argv.slice(2);
const steps = MODE === 'route' ? JSON.parse(readFileSync(new globalThis.URL('./route-fork.json', import.meta.url))) : [];

const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/bench/rec-${PORT}`, '--window-size=1200,1000',
   '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
const out = createWriteStream(`${OUT}.h264`);
let id = 0; const w = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.bindingCalled' && m.params.name === '__out') out.write(Buffer.from(m.params.payload, 'base64'));
  if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
};
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result?.result?.value; };

const RECORDER = `(async () => {
  const LABEL = ${JSON.stringify(LABEL)}, BARCODE = ${MODE === 'barcode'};
  const W = 804, H = 1748, BAND = 96, OH = H + BAND;
  const rec = document.createElement('canvas'); rec.width = W; rec.height = OH;
  const ctx = rec.getContext('2d', { alpha: false });
  const XS = [0.0833, 0.25, 0.4167, 0.5833, 0.75, 0.9167], YS = [0.2809, 0.3576, 0.4342, 0.5109], TOP = 0.2426, BOTTOM = 0.5492;
  const off = document.createElement('canvas'); off.width = 60; off.height = 40;
  const octx = off.getContext('2d', { willReadFrequently: true });
  function source() {
    const v = [...document.querySelectorAll('video')].find((v) => v.videoWidth > 0);
    if (v) return [v, v.videoWidth, v.videoHeight];
    const cs = [...document.querySelectorAll('canvas')].filter((c) => c !== rec && c.width > 200 && c.height > 400);
    cs.sort((a, b) => b.width * b.height - a.width * a.height);
    return cs[0] ? [cs[0], cs[0].width, cs[0].height] : null;
  }
  function readCode(el, w, h) {
    octx.drawImage(el, 0, h * TOP, w, h * (BOTTOM - TOP), 0, 0, 60, 40);
    const d = octx.getImageData(0, 0, 60, 40).data;
    const lum = (c, r) => { const x = Math.round(XS[c] * 60), y = Math.round((YS[r] - TOP) / (BOTTOM - TOP) * 40); const i = (y * 60 + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
    for (let c = 0; c < 6; c++) { const l = lum(c, 0); if (c % 2 ? l > 80 : l < 175) return null; }
    let v = 0; for (let b = 0; b < 18; b++) v = (v << 1) | (lum(b % 6, 1 + Math.floor(b / 6)) > 128 ? 1 : 0);
    return v;
  }
  const S = window.__rec = { n: 0, gaps: [], last: 0, stop: false, done: null, lat: [], changes: [], size: '' };
  const pending = [];
  const flush = () => { if (!pending.length) return; let total = 0; for (const p of pending) total += p.length; const all = new Uint8Array(total); let o = 0; for (const p of pending) { all.set(p, o); o += p.length; } pending.length = 0; let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000)); __out(btoa(s)); };
  S.outputs = 0;
  const enc = new VideoEncoder({ output: (chunk) => { S.outputs++; const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); pending.push(b); }, error: (e) => { S.error = String(e); } });
  enc.configure({ codec: 'avc1.640033', width: W, height: OH, bitrate: 24e6, framerate: 60, latencyMode: 'realtime', hardwareAcceleration: 'prefer-hardware', avc: { format: 'annexb' } });
  let lastCode = null, changeTimes = [], latWin = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    S.done = resolve;
    function tick(now) {
      try { step(now); } catch (e) { S.error = String(e && e.stack || e); resolve(); }
    }
    function step(now) {
      if (S.last) S.gaps.push(now - S.last); S.last = now;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, OH);
      const s = source();
      if (s) {
        const [el, w, h] = s; S.size = w + 'x' + h;
        ctx.drawImage(el, 0, BAND, W, H);
        if (BARCODE) {
          try {
            const v = readCode(el, w, h);
            if (v !== null) {
              if (v !== lastCode) { lastCode = v; changeTimes.push(now); }
              const age = ((Date.now() & 0x3ffff) - v + 0x40000) % 0x40000;
              latWin.push(age); if (latWin.length > 30) latWin.shift(); S.lat.push(age);
            }
          } catch {}
        }
      }
      while (changeTimes.length && now - changeTimes[0] > 1000) changeTimes.shift();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 34px -apple-system, Helvetica, sans-serif'; ctx.textBaseline = 'top';
      ctx.fillText(LABEL, 16, 10);
      ctx.font = '26px Menlo, monospace'; ctx.fillStyle = '#9ef';
      let info = 't ' + ((now - t0) / 1000).toFixed(1) + 's  src ' + S.size;
      if (BARCODE) info = 'shown ' + (latWin.length ? Math.round(latWin.reduce((a, b) => a + b, 0) / latWin.length) : '–') + ' ms old  ' + changeTimes.length + ' new fps  ' + S.size;
      ctx.fillText(info, 16, 56);
      const frame = new VideoFrame(rec, { timestamp: Math.round(S.n * 1e6 / 60), duration: Math.round(1e6 / 60) });
      enc.encode(frame, { keyFrame: S.n % 120 === 0 }); frame.close();
      S.n++;
      if (S.n % 10 === 0) flush();
      if (S.stop) { enc.flush().then(() => { flush(); resolve(); }); return; }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
  return true;
})()`;

try {
  await cdp('Page.navigate', { url: URL });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!([...document.querySelectorAll('video')].find(v=>v.videoWidth>0) || [...document.querySelectorAll('canvas')].find(c=>c.width>200&&c.height>400))`)) break; }
  await sleep(2500);
  await cdp('Runtime.enable');
  await cdp('Runtime.addBinding', { name: '__out' });
  cdp('Runtime.evaluate', { expression: RECORDER, awaitPromise: true }); // runs until __rec.stop
  await sleep(1500);
  const rect = await ev(`(() => { const v = [...document.querySelectorAll('video')].find(v=>v.videoWidth>0); const c = v || [...document.querySelectorAll('canvas')].filter(c=>c.width>200&&c.height>400).sort((a,b)=>b.width*b.height-a.width*a.height)[0]; const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const at = (fx, fy) => ({ x: rect.x + rect.w * fx, y: rect.y + rect.h * fy });
  const mouse = (type, fx, fy) => cdp('Input.dispatchMouseEvent', { type, ...at(fx, fy), button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const startFrame = await ev('__rec.n');
  if (MODE === 'route') {
    for (const s of steps) {
      if (s.op === 'wait') await sleep(s.ms);
      if (s.op === 'tap') { await mouse('mousePressed', s.x, s.y); await sleep(60); await mouse('mouseReleased', s.x, s.y); }
      if (s.op === 'swipe') { await mouse('mousePressed', s.x0, s.y0); for (let k = 1; k <= 14; k++) { await sleep(16); await mouse('mouseMoved', s.x0 + (s.x1 - s.x0) * k / 14, s.y0 + (s.y1 - s.y0) * k / 14); } await sleep(16); await mouse('mouseReleased', s.x1, s.y1); }
      if (s.wait) await sleep(s.wait);
    }
    await sleep(800);
  } else {
    await sleep(20000);
  }
  await ev('__rec.stop = true');
  await sleep(1500); // let the encoder flush
  const stats = await ev(`(() => { const g = __rec.gaps; const lat = __rec.lat.slice().sort((a,b)=>a-b); return { frames: __rec.n, outputs: __rec.outputs, queue: 0, size: __rec.size, error: __rec.error || null, gapsOver20: g.filter(x => x > 20).length, gapMax: Math.max(...g), latMean: lat.length ? lat.reduce((a,b)=>a+b,0)/lat.length : null, latP95: lat.length ? lat[Math.floor(lat.length*0.95)] : null }; })()`);
  writeFileSync(`${OUT}.json`, JSON.stringify({ label: LABEL, url: URL, mode: MODE, startFrame, rect, ...stats }, null, 1));
  console.log(JSON.stringify({ label: LABEL, startFrame, ...stats }));
} finally {
  await sleep(300); out.end(); ws.close(); chrome.kill();
}
