const { createServer } = require('node:http');
const { createConnection } = require('node:net');
const { join, resolve } = require('node:path');
const proofRoot = resolve(process.argv[2] || 'hid-close-results');
const { writeFileSync } = require('node:fs');
const reason = 'Simulator input unavailable; retry after other clients disconnect';

function maskedInput() {
  const payload = Buffer.concat([Buffer.from([3]), Buffer.from('{"type":"begin","x":0.5,"y":0.5}')]);
  const mask = Buffer.from([1, 2, 3, 4]);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x82, 0x80 | payload.length]), mask, payload]);
}

async function trial(variant) {
  const adapter = require(join(proofRoot, `${variant}-adapter.cjs`));
  const events = [];
  let started;
  let upgradedSocket;
  let closeAtMs = null;
  const log = (event, details = {}) => events.push({ ms: performance.now() - started, event, ...details });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    started = performance.now(); upgradedSocket = socket;
    log('upgrade');
    socket.on('error', error => log('server-error', { code: error.code }));
    socket.on('data', data => log('server-data', { bytes: data.length }));
    socket.on('end', () => log('server-peer-end'));
    socket.on('finish', () => log('server-finish'));
    socket.on('close', hadError => { closeAtMs = performance.now() - started; log('server-close', { hadError }); });
    adapter.writeWebSocketAccept(req, socket, '');
    const hid = adapter.rawHidSocket(socket, head);
    hid.close(1013, reason);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let interval;
  let received = Buffer.alloc(0);
  let responseRead = false;
  const peer = createConnection({ host: '127.0.0.1', port: server.address().port, allowHalfOpen: true });
  peer.on('error', error => { if (started !== undefined) log('peer-error', { code: error.code }); });
  peer.on('end', () => log('peer-read-end'));
  peer.on('close', hadError => log('peer-close', { hadError }));
  peer.on('data', data => {
    received = Buffer.concat([received, data]);
    if (!responseRead && received.includes(Buffer.from('\r\n\r\n'))) {
      responseRead = true;
      log('peer-handshake-read');
      peer.write(maskedInput());
      interval = setInterval(() => { if (!peer.destroyed) peer.write(maskedInput()); }, 100);
    }
  });
  peer.on('connect', () => peer.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: cHJpdmF0ZS1wcm9vZi1rZXk=\r\n\r\n'));
  try {
    while (started === undefined) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const at1200 = { destroyed: upgradedSocket.destroyed, readable: upgradedSocket.readable,
      writable: upgradedSocket.writable, writableFinished: upgradedSocket.writableFinished,
      closeAtMs, receivedClientChunks: events.filter(event => event.event === 'server-data').length };
    return { variant, note: 'Owned raw peer ignores the WebSocket close, keeps TCP write side open, and sends masked input every 100ms after reading the upgrade. Snapshot taken after 1200ms.', at1200, events };
  } finally {
    clearInterval(interval);
    peer.destroy(); upgradedSocket?.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

(async () => {
  const trials = [];
  for (const variant of ['baseline', 'end-only', 'grace', 'final']) trials.push(await trial(variant));
  const artifact = join(proofRoot, 'stubborn-peer-results.json');
  writeFileSync(artifact, JSON.stringify({ generatedAt: new Date().toISOString(), node: process.version, trials }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ artifact, trials: trials.map(({ variant, at1200 }) => ({ variant, ...at1200 })) }, null, 2));
  if (trials[1].at1200.destroyed || !trials[2].at1200.destroyed || !trials[3].at1200.destroyed) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
