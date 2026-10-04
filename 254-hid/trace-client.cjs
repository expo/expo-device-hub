const fs = require('node:fs');
const WebSocket = require(require('node:module').createRequire(require('node:path').join(process.env.SERVE_SIM_REPRO_PACKAGE, 'package.json')).resolve('ws'));
const start = performance.now();
const log = (event, details = {}) => fs.appendFileSync(process.env.SERVE_SIM_REPRO_TRACE,
  JSON.stringify({ ms: performance.now() - start, event, ...details }) + '\n', { mode: 0o600 });
const originalEmit = WebSocket.prototype.emit;
WebSocket.prototype.emit = function(event, ...args) {
  if (event === 'open') this._receiver?.on('conclude', (code, reason) => log('close-frame', { code, reason: String(reason) }));
  if (['open', 'close', 'error', 'ping', 'pong', 'message'].includes(event)) {
    const details = event === 'close' ? { code: args[0], reason: String(args[1]) }
      : event === 'error' ? { error: String(args[0]) }
      : event === 'message' ? { bytes: args[0].length, tag: args[0][0] } : {};
    log(event, details);
  }
  return originalEmit.call(this, event, ...args);
};
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = function(data, ...args) {
  log('send', { tag: data[0], bytes: data.length, readyState: this.readyState,
    closeCode: this._closeCode, payload: Buffer.from(data).subarray(1).toString() });
  return originalSend.call(this, data, ...args);
};
process.on('exit', code => log('exit', { code }));
