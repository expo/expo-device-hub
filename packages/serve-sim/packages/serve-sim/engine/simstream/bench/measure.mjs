// Transport-agnostic glass-to-glass-ish measurement: at every display refresh, decode the barcode
// clock from what the viewer page is actually showing and record its age. Same machine = same clock.
import { spawn } from 'node:child_process';
const [URL, LABEL = '', WARM = '5', SECS = '20', PORT = '9350'] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/bench/chrome-${PORT}`, '--window-size=1200,1000',
   '--autoplay-policy=no-user-gesture-required', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await cdp('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
try {
  await cdp('Page.navigate', { url: URL });
  // Install the sampler; it waits for a valid barcode before recording.
  const SAMPLER = `(() => {
    const XS = [0.0833, 0.25, 0.4167, 0.5833, 0.75, 0.9167], YS = [0.2809, 0.3576, 0.4342, 0.5109];
    const TOP = 0.2426, BOTTOM = 0.5492;  // barcode region, normalized
    const off = document.createElement('canvas'); off.width = 60; off.height = 40;
    const octx = off.getContext('2d', { willReadFrequently: true });
    window.__m = { samples: [], src: null, size: null, recording: false };
    function source() {
      const v = [...document.querySelectorAll('video')].find((v) => v.videoWidth > 0);
      if (v) return [v, v.videoWidth, v.videoHeight, 'video'];
      const cs = [...document.querySelectorAll('canvas')].filter((c) => c.width > 200 && c.height > 400);
      cs.sort((a, b) => b.width * b.height - a.width * a.height);
      if (cs[0]) return [cs[0], cs[0].width, cs[0].height, 'canvas'];
      const im = [...document.querySelectorAll('img')].find((i) => i.naturalWidth > 200);
      if (im) return [im, im.naturalWidth, im.naturalHeight, 'img'];
      return null;
    }
    // First-seen time of each distinct frame, polled every ~1 ms: independent of display phase.
    __m.first = []; __m.pollTimes = []; let lastSeen = null;
    function readCode() {
      const s = source(); if (!s) return null;
      const [el, w, h] = s;
      octx.drawImage(el, 0, h * TOP, w, h * (BOTTOM - TOP), 0, 0, 60, 40);
      const d = octx.getImageData(0, 0, 60, 40).data;
      const lum = (c, r) => { const x = Math.round(XS[c] * 60), y = Math.round((YS[r] - TOP) / (BOTTOM - TOP) * 40); const i = (y * 60 + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
      for (let c = 0; c < 6; c++) { const l = lum(c, 0); if (c % 2 ? l > 80 : l < 175) return null; }
      let v = 0; for (let b = 0; b < 18; b++) v = (v << 1) | (lum(b % 6, 1 + Math.floor(b / 6)) > 128 ? 1 : 0);
      return v;
    }
    setInterval(() => {
      if (!__m.recording) return;
      const now = performance.timeOrigin + performance.now();
      __m.pollTimes.push(now);
      let v; try { v = readCode(); } catch (e) { return; }
      if (v !== null && v !== lastSeen) { lastSeen = v; __m.first.push([now, v]); }
    }, 1);
    function frame() {
      const s = source();
      if (s) {
        const [el, w, h, kind] = s;
        __m.src = kind; __m.size = w + 'x' + h;
        try {
          octx.drawImage(el, 0, h * TOP, w, h * (BOTTOM - TOP), 0, 0, 60, 40);
          const d = octx.getImageData(0, 0, 60, 40).data;
          const lum = (c, r) => { const x = Math.round(XS[c] * 60), y = Math.round((YS[r] - TOP) / (BOTTOM - TOP) * 40); const i = (y * 60 + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
          let ok = true; for (let c = 0; c < 6; c++) { const l = lum(c, 0); if (c % 2 ? l > 80 : l < 175) ok = false; }
          if (ok) {
            let v = 0; for (let b = 0; b < 18; b++) v = (v << 1) | (lum(b % 6, 1 + Math.floor(b / 6)) > 128 ? 1 : 0);
            if (__m.recording) __m.samples.push([Date.now(), v]);
            __m.valid = true;
          }
        } catch (e) { __m.err = String(e); }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  })()`;
  for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`document.readyState === 'complete'`)) break; }
  await ev(SAMPLER);
  let valid = false; for (let i = 0; i < 40 && !valid; i++) { await sleep(500); valid = await ev(`!!(window.__m && __m.valid)`); }
  if (!valid) { console.log(JSON.stringify({ label: LABEL, error: 'no valid barcode in view', info: await ev(`window.__m && { src: __m.src, size: __m.size, err: __m.err }`) })); process.exit(0); }
  await sleep(Number(WARM) * 1000);
  await ev(`__m.recording = true`); await sleep(Number(SECS) * 1000); await ev(`__m.recording = false`);
  const [samples, src, size, first, pollTimes] = [await ev(`__m.samples`), await ev(`__m.src`), await ev(`__m.size`), await ev(`__m.first`), await ev(`__m.pollTimes`)];
  const firstAge = first.map(([now, v]) => ((Math.floor(now) & 0x3ffff) - v + 262144) % 262144).filter((a) => a < 5000);
  const pollGaps = pollTimes.slice(1).map((t, i) => t - pollTimes[i]);
  const age = samples.map(([now, v]) => ((now & 0x3ffff) - v + 262144) % 262144).filter((a) => a < 5000);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };
  // distinct frames shown, and the source-clock step between successive distinct frames
  const changes = []; let last = null;
  for (const [now, v] of samples) { if (v !== last) { if (last !== null) changes.push({ now, step: (v - last + 262144) % 262144 }); last = v; } }
  const shownGaps = changes.slice(1).map((c, i) => c.now - changes[i].now);
  const steps = changes.map((c) => c.step).filter((s) => s < 1000);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(JSON.stringify({
    label: LABEL, src, size, refreshSamples: samples.length,
    arrivalAgeMean: +mean(firstAge).toFixed(1), arrivalAgeP50: +q(firstAge, 0.5).toFixed(1), arrivalAgeP95: +q(firstAge, 0.95).toFixed(1),
    pollPeriodMs: +mean(pollGaps).toFixed(2),
    ageMean: +mean(age).toFixed(1), ageP95: q(age, 0.95),
    distinctFps: +(changes.length / Number(SECS)).toFixed(1),
    sourceStepMean: +mean(steps).toFixed(1), skippedShare: +(steps.filter((s) => s > 25).length / steps.length).toFixed(3),
    freezes50ms: shownGaps.filter((g) => g > 50).length, worstFreezeMs: Math.max(...shownGaps),
  }));
} finally { ws.close(); chrome.kill(); }
