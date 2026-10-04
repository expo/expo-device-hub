const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createRequire } = require('node:module');
const repoRoot = resolve(process.argv[2] || '.');
const packageRoot = join(repoRoot, 'packages/serve-sim/packages/serve-sim');
const WebSocket = require(createRequire(join(packageRoot, 'package.json')).resolve('ws'));

const proofRoot = resolve(process.argv[3] || 'hid-close-results');
mkdirSync(proofRoot, { recursive: true, mode: 0o700 });
const cli = join(packageRoot, 'dist/serve-sim.js');
const sourceRoot = join(packageRoot, 'src/socket');
const device = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';
const reason = 'Simulator input unavailable; retry after other clients disconnect';
const variants = (process.argv[4] || 'baseline,end-only,grace,final').split(',');
const rounds = Number(process.argv[5] || 10);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 100) throw new Error('rounds must be 1..100');
if (variants.some(v => !['baseline', 'end-only', 'grace', 'final'].includes(v))) throw new Error('Unknown variant');
const clients = ['cli', 'passive'];
const adapters = Object.fromEntries(variants.map(name => [name, require(join(proofRoot, `${name}-adapter.cjs`))]));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

function frames(buffer) {
  const found = [];
  let at = 0;
  while (buffer.length >= at + 2) {
    const opcode = buffer[at] & 15;
    const masked = (buffer[at + 1] & 128) !== 0;
    let length = buffer[at + 1] & 127;
    let offset = at + 2;
    if (length === 126) {
      if (buffer.length < offset + 2) break;
      length = buffer.readUInt16BE(offset); offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) break;
      length = Number(buffer.readBigUInt64BE(offset)); offset += 8;
    }
    const maskAt = offset;
    if (masked) offset += 4;
    if (buffer.length < offset + length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[maskAt + i % 4];
    found.push({ opcode, bytes: length,
      ...(opcode === 8 ? { code: length >= 2 ? payload.readUInt16BE(0) : null, reason: payload.subarray(2).toString() } : {}),
      ...(opcode === 2 ? { tag: payload[0], payload: payload.subarray(1).toString() } : {}),
    });
    at = offset + length;
  }
  return { found, rest: buffer.subarray(at) };
}

async function trial(variant, client, iteration) {
  const id = `${iteration.toString().padStart(2, '0')}-${variant}-${client}`;
  const fixture = mkdtempSync(join(proofRoot, 'private-state-'));
  const stateDir = join(fixture, 'state');
  const binDir = join(fixture, 'bin');
  const trace = join(proofRoot, `${id}-client.jsonl`);
  mkdirSync(stateDir); mkdirSync(binDir);
  writeFileSync(trace, '', { mode: 0o600 });
  const xcrun = join(binDir, 'xcrun');
  writeFileSync(xcrun, `#!/bin/sh\ncase "$*" in\n  "simctl list devices booted -j") ;;\n  *) echo "unexpected xcrun call: $*" >&2; exit 1 ;;\nesac\nprintf '%s\\n' '{"devices":{"private-mock":[{"udid":"${device}","state":"Booted"}]}}'\n`);
  chmodSync(xcrun, 0o755);
  const serverEvents = [];
  const sockets = new Set();
  let upgradedAt;
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    upgradedAt = performance.now(); sockets.add(socket);
    const log = (event, details = {}) => serverEvents.push({ ms: performance.now() - upgradedAt, event, ...details });
    log('upgrade', { headBytes: head.length, path: req.url });
    const originalEnd = socket.end;
    socket.end = function(data, ...args) {
      log('socket-end', { frames: Buffer.isBuffer(data) ? frames(data).found : [], bytes: data?.length });
      return originalEnd.call(this, data, ...args);
    };
    const originalDestroySoon = socket.destroySoon;
    socket.destroySoon = function(...args) {
      log('destroySoon', { bytesWritten: this.bytesWritten, bytesRead: this.bytesRead });
      return originalDestroySoon.apply(this, args);
    };
    socket.on('error', error => log('socket-error', { code: error.code, error: error.message }));
    socket.on('finish', () => log('socket-finish'));
    socket.on('end', () => log('socket-peer-end'));
    socket.on('close', hadError => { log('socket-close', { hadError, bytesWritten: socket.bytesWritten, bytesRead: socket.bytesRead }); sockets.delete(socket); });
    let incoming = head;
    socket.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      const decoded = frames(incoming); incoming = decoded.rest;
      log('socket-data', { bytes: chunk.length, frames: decoded.found });
    });
    const { writeWebSocketAccept, rawHidSocket } = adapters[variant];
    if (!writeWebSocketAccept(req, socket, '')) return;
    log('handshake-written');
    const hid = rawHidSocket(socket, head);
    log('raw-adapter-created');
    hid.close(1013, reason);
    log('refusal-returned');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const state = { pid: process.pid, port, device, inputAdmission: true,
    url: `http://127.0.0.1:${port}`,
    streamUrl: `http://127.0.0.1:${port}/helper/${device}/stream.mjpeg`,
    wsUrl: `ws://127.0.0.1:${port}/helper/${device}/ws` };
  writeFileSync(join(stateDir, `server-${device}.json`), JSON.stringify(state), { mode: 0o600 });
  let child;
  let ws;
  let stdout = '';
  let stderr = '';
  let deadline;
  let timedOut = false;
  const started = performance.now();
  try {
    let outcome;
    if (client === 'cli') {
      child = spawn(process.execPath, ['--require', join(__dirname, 'trace-client.cjs'), cli, 'tap', '0.5', '0.5', '-d', device], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH || ''}`, SERVE_SIM_STATE_DIR: stateDir, SERVE_SIM_REPRO_TRACE: trace, SERVE_SIM_REPRO_PACKAGE: packageRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => { stdout += chunk.toString(); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); });
      deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
      outcome = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
    } else {
      const clientEvents = [];
      const log = (event, details = {}) => clientEvents.push({ ms: performance.now() - started, event, ...details });
      ws = new WebSocket(state.wsUrl);
      ws.on('open', () => {
        log('open');
        ws._receiver.on('conclude', (code, closeReason) => log('close-frame', { code, reason: String(closeReason) }));
      });
      ws.on('ping', () => log('ping'));
      ws.on('error', error => log('error', { error: String(error) }));
      deadline = setTimeout(() => { timedOut = true; ws.terminate(); }, 5000);
      outcome = await new Promise(resolve => ws.on('close', (code, closeReason) => {
        log('close', { code, reason: String(closeReason) });
        resolve({ exitCode: null, signal: null });
      }));
      writeFileSync(trace, clientEvents.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
    }
    clearTimeout(deadline);
    await new Promise(resolve => setImmediate(resolve));
    const clientEvents = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const close = clientEvents.find(event => event.event === 'close');
    const conclude = clientEvents.find(event => event.event === 'close-frame');
    return { id, variant, client, iteration, node: process.version, ...outcome, timedOut,
      elapsedMs: performance.now() - started, closeCode: close?.code, concludeCode: conclude?.code ?? null,
      stdout, stderrSummary: stderr.split('\n').find(line => line.startsWith('Error:')) || (stderr ? 'CLI emitted stderr; no Error line' : ''), clientEvents, serverEvents, noAdmissionWasSent: true };
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(fixture, { recursive: true, force: true });
  }
}

(async () => {
  const files = { 'dist/serve-sim.js': cli, 'src/socket/server-input.ts': join(sourceRoot, 'server-input.ts'), 'src/socket/server-upgrade.ts': join(sourceRoot, 'server-upgrade.ts') };
  const hashesBefore = Object.fromEntries(Object.entries(files).map(([label, file]) => [label, hash(file)]));
  const trials = [];
  // Freeze the round count before running; reverse both orders every round.
  for (let iteration = 0; iteration < rounds; iteration++) {
    const adapterOrder = iteration % 2 ? [...variants].reverse() : variants;
    const clientOrder = iteration % 2 ? [...clients].reverse() : clients;
    for (const variant of adapterOrder) for (const client of clientOrder) trials.push(await trial(variant, client, iteration));
  }
  const hashesAfter = Object.fromEntries(Object.entries(files).map(([label, file]) => [label, hash(file)]));
  const cells = variants.flatMap(variant => clients.map(client => {
    const selected = trials.filter(t => t.variant === variant && t.client === client);
    return { variant, client, trials: selected.length,
      closeCodes: selected.reduce((acc, t) => { acc[t.closeCode] = (acc[t.closeCode] || 0) + 1; return acc; }, {}),
      concludeCodes: selected.reduce((acc, t) => { acc[t.concludeCode] = (acc[t.concludeCode] || 0) + 1; return acc; }, {}),
      exitCodes: selected.reduce((acc, t) => { acc[t.exitCode] = (acc[t.exitCode] || 0) + 1; return acc; }, {}),
      timedOut: selected.filter(t => t.timedOut).length,
    };
  }));
  const result = { generatedAt: new Date().toISOString(), node: process.version,
    design: `${rounds} frozen rounds per adapter/client cell; both orders reverse every round. Pinned source rawHidSocket/writeWebSocketAccept bundled by Bun, immediate refusal after upgrade. Prototype variants preserve the original diagnostic code; final is exact published source.`,
    sourceVariants: JSON.parse(readFileSync(join(proofRoot, 'source-variants.json'), 'utf8')),
    hashesBefore, hashesAfter, cells, trials };
  writeFileSync(join(proofRoot, 'results.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ artifact: join(proofRoot, 'results.json'), node: process.version, cells,
    sourceAndCliUnchanged: JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter) }, null, 2));
  if (trials.some(t => t.timedOut) || JSON.stringify(hashesBefore) !== JSON.stringify(hashesAfter)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
