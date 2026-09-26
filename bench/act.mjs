// act.mjs <port> <cmd...>: tap x y | swipe x0 y0 x1 y1 [edge] | wait ms
const [port, ...args] = process.argv.slice(2);
const ws = new WebSocket(`ws://localhost:${port}/stream`); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => { ws.send(JSON.stringify({ t: 'pause' })); let seq = 1; const t = (p, x, y, edge = 0) => ws.send(JSON.stringify({ t: 'touch', p, x, y, seq: seq++, edge }));
  for (let i = 0; i < args.length;) { const c = args[i++];
    if (c === 'tap') { const x = +args[i++], y = +args[i++]; t('down', x, y); await sleep(70); t('up', x, y); }
    else if (c === 'swipe') { const [x0, y0, x1, y1] = args.slice(i, i + 4).map(Number); i += 4; const edge = /^\d$/.test(args[i] ?? '') ? +args[i++] : 0; t('down', x0, y0, edge); for (let k = 1; k <= 14; k++) { await sleep(16); t('move', x0 + (x1 - x0) * k / 14, y0 + (y1 - y0) * k / 14, edge); } await sleep(16); t('up', x1, y1, edge); }
    else if (c === 'wait') await sleep(+args[i++]); }
  await sleep(200); process.exit(0); };
