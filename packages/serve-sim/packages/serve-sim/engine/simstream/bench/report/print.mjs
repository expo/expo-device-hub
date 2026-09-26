// Print an HTML file to PDF with headless Chrome (CDP), with a page-number footer.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [HTML, OUT, PORT = '9395'] = process.argv.slice(2);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=/tmp/simreport/chrome`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let t; for (let i = 0; i < 60; i++) { try { t = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(200); } }
const ws = new WebSocket(t.find((x) => x.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const w = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && w.has(m.id)) { w.get(m.id)(m); w.delete(m.id); } };
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; w.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Page.enable');
await cdp('Page.navigate', { url: 'file://' + HTML });
await sleep(1500);
const footer = `<div style="width:100%;font-family:'Helvetica Neue',Helvetica,sans-serif;font-size:7.5pt;color:#8a8f98;padding:0 0.9in;display:flex;justify-content:space-between">
  <span>serve-sim + simstream vs stock serve-sim</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
const r = await cdp('Page.printToPDF', {
  printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true,
  headerTemplate: '<div></div>', footerTemplate: footer,
});
writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
console.log(OUT);
ws.close(); chrome.kill();
