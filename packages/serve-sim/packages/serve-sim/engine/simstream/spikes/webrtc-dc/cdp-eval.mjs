// Debug aid: open a page in headless Chrome, wait, print the value of a JS expression as JSON.
//   node cdp-eval.mjs <url> <waitSecs> '<expression>' [debugPort=9480]
import { spawn } from 'node:child_process';
const [URL, WAIT = '5', EXPR = 'document.title', PORT = '9480'] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${process.env.TMPDIR}cdp-eval-${PORT}`, '--window-size=500,1000', 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); const logs = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
};
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
try {
  await cdp('Runtime.enable');
  await cdp('Page.navigate', { url: URL });
  await sleep(Number(WAIT) * 1000);
  const r = await cdp('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
  console.log(JSON.stringify({ value: r.result?.result?.value, error: r.result?.exceptionDetails?.exception?.description, logs }, null, 1));
} finally { ws.close(); chrome.kill(); }
