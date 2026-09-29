// Light viewer for the spike page: no pixel readback. Loads the page, warms up, records the page's
// own header-based metrics (frame age vs capture time, clock-offset corrected), prints one JSON line.
//   node lite-viewer.mjs <url> <label> [warmSecs=5] [secs=20] [debugPort=9440]
// VIEWER_LOAD=ui        25 ms of main-thread work every 100 ms (a busy app, e.g. a React UI)
// VIEWER_LOAD=readback  pixel readback of the video canvas every ~1 ms (what the barcode harness does)
import { spawn } from 'node:child_process';
const [URL, LABEL, WARM = '5', SECS = '20', PORT = '9440'] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TMPDIR}lite-${PORT}`, '--window-size=500,1000',
   ...(process.env.EXTRA_CHROME_ARGS ? process.env.EXTRA_CHROME_ARGS.split(' ') : []), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, returnByValue: true })).result?.result?.value;
try {
  const LOAD = process.env.VIEWER_LOAD || 'none';
  const loads = {
    ui: `setInterval(() => { const t = performance.now(); while (performance.now() - t < 25) {} }, 100);`,
    readback: `(() => { const off = document.createElement('canvas'); off.width = 60; off.height = 40;
      const o = off.getContext('2d', { willReadFrequently: true });
      setInterval(() => { const c = document.querySelector('canvas'); if (!c || c.width < 200) return;
        o.drawImage(c, 0, c.height * 0.25, c.width, c.height * 0.3, 0, 0, 60, 40); o.getImageData(0, 0, 60, 40); }, 1); })();`,
  };
  if (loads[LOAD]) { await cdp('Page.enable'); await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('load', () => { ${loads[LOAD]} });` }); }
  await cdp('Page.navigate', { url: URL });
  await sleep(Number(WARM) * 1000);
  await ev('window.__startRecording && window.__startRecording()');
  await sleep(Number(SECS) * 1000);
  const s = await ev('window.__summary ? JSON.stringify(window.__summary()) : null');
  console.log(JSON.stringify({ label: LABEL, load: LOAD, ...(s ? JSON.parse(s) : { error: 'no summary' }) }));
} finally { ws.close(); chrome.kill(); }
