import { readFileSync } from 'node:fs'; import { execSync } from 'node:child_process';
const steps = JSON.parse(readFileSync('/tmp/demo-steps.json', 'utf8'));
const ws = new WebSocket('ws://localhost:8765/stream'); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
ws.onopen = async () => { ws.send(JSON.stringify({ t: 'pause' })); let seq = 1; const t = (p, x, y, edge = 0) => ws.send(JSON.stringify({ t: 'touch', p, x, y, seq: seq++, edge }));
  for (const s of steps) {
    if (s.op === 'tap') { t('down', s.x, s.y); await sleep(70); t('up', s.x, s.y); }
    if (s.op === 'swipe') { const e = s.edge || 0; t('down', s.x0, s.y0, e); for (let k = 1; k <= 14; k++) { await sleep(16); t('move', s.x0 + (s.x1 - s.x0) * k / 14, s.y0 + (s.y1 - s.y0) * k / 14, e); } await sleep(16); t('up', s.x1, s.y1, e); }
    if (s.op === 'shot') execSync(`xcrun simctl io booted screenshot /tmp/dry-${s.name}.png && sips -Z 400 /tmp/dry-${s.name}.png >/dev/null`, { stdio: 'ignore' });
    await sleep(s.wait ?? s.ms ?? 0);
  }
  process.exit(0); };
