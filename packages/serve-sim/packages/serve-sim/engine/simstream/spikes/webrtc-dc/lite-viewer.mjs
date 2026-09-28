// Light viewer for the spike page: no pixel readback. Loads the page, warms up, records the page's
// own header-based metrics (frame age vs capture time, clock-offset corrected), prints one JSON line.
//   node lite-viewer.mjs <url> <label> [warmSecs=5] [secs=20] [debugPort=9440]
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
  await cdp('Page.navigate', { url: URL });
  await sleep(Number(WARM) * 1000);
  await ev('window.__startRecording && window.__startRecording()');
  await sleep(Number(SECS) * 1000);
  const s = await ev('window.__summary ? JSON.stringify(window.__summary()) : null');
  console.log(JSON.stringify({ label: LABEL, ...(s ? JSON.parse(s) : { error: 'no summary' }) }));
} finally { ws.close(); chrome.kill(); }
