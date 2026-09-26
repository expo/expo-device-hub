// Saves the received stream (Annex B) and each frame's size, as a viewer with the given settings.
import { openSync, writeSync, closeSync, writeFileSync } from 'node:fs';
const [url, out, ms] = process.argv.slice(2);
const fd = openSync(out + '.h264', 'w'); const sizes = []; let cfg = false; const START = Buffer.from([0, 0, 0, 1]);
const ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', codecs: ['h264'] }));
ws.onmessage = (e) => {
  if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t !== 'config') return; const c = Buffer.from(m.description, 'base64');
    let o = 5; const ns = c[o++] & 0x1f; for (let i = 0; i < ns; i++) { const l = c.readUInt16BE(o); o += 2; writeSync(fd, START); writeSync(fd, c.subarray(o, o + l)); o += l; }
    const np = c[o++]; for (let i = 0; i < np; i++) { const l = c.readUInt16BE(o); o += 2; writeSync(fd, START); writeSync(fd, c.subarray(o, o + l)); o += l; } cfg = true; return; }
  const b = Buffer.from(e.data); ws.send(JSON.stringify({ t: 'ack', seq: b.readUInt32LE(1) })); if (!cfg) return;
  sizes.push(b.length - 49); for (let o = 49; o < b.length;) { const l = b.readUInt32BE(o); o += 4; writeSync(fd, START); writeSync(fd, b.subarray(o, o + l)); o += l; }
};
setTimeout(() => { closeSync(fd); writeFileSync(out + '.sizes', sizes.join('\n')); process.exit(0); }, Number(ms));
