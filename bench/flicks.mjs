// Drives continuous Calendar year-view flicks through the local server for N seconds.
const [port, seconds] = process.argv.slice(2).map(Number);
const ws = new WebSocket(`ws://localhost:${port}/stream`); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => { ws.send(JSON.stringify({ t: 'pause' })); let seq = 1; const t = (p, x, y) => ws.send(JSON.stringify({ t: 'touch', p, x, y, seq: seq++, edge: 0 }));
  const end = performance.now() + seconds * 1000; let dir = 1;
  while (performance.now() < end) { const [a, b] = dir > 0 ? [0.8, 0.2] : [0.2, 0.8]; t('down', 0.5, a); for (let i = 1; i <= 8; i++) { await sleep(16); t('move', 0.5, a + (b - a) * i / 8); } await sleep(16); t('up', 0.5, b); dir = -dir; await sleep(900); }
  process.exit(0); };
