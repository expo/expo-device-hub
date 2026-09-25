import cp from 'node:child_process';
const t0 = Date.now();
for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
  const orig = cp[name];
  cp[name] = function (...args) { const s = performance.now(); try { return orig.apply(this, args); } finally { const d = performance.now() - s; if (d > 15) process.stderr.write(`[lag] ${name} ${d.toFixed(0)}ms ${String(args[0]).slice(0, 40)} ${JSON.stringify(args[1] ?? '').slice(0, 60)}\n`); } };
}
import { syncBuiltinESMExports } from 'node:module'; syncBuiltinESMExports();
let last = performance.now();
setInterval(() => { const now = performance.now(); if (now - last > 40) process.stderr.write(`[lag] event loop blocked ${(now - last - 10).toFixed(0)}ms at +${((Date.now() - t0) / 1000).toFixed(1)}s\n`); last = now; }, 10).unref();
