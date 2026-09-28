// Spike: carry the simstream engine's stream over a WebRTC data channel instead of a WebSocket.
//
//   node bridge.mjs <engine-port> <listen-port> <ordered|unordered|unreliable>
//
// The engine is unchanged: for each browser, the bridge opens a normal viewer connection to the
// engine's /stream WebSocket (on loopback) and relays it over WebRTC:
//   - "video": binary frames, chunked (data channel messages are size-limited), in the mode under test
//       ordered    = reliable + ordered (TCP-like: a loss holds up everything behind it)
//       unordered  = reliable, unordered (retransmits, but a loss only delays its own chunk)
//       unreliable = unordered, no retransmits (a loss drops the frame; the page asks for a keyframe)
//   - "ctl": reliable + ordered, JSON both ways (config, acks, settings, keyframe requests).
// Signaling (SDP/ICE) goes over a WebSocket on the same port that serves page.html.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import ndc from 'node-datachannel';

const [ENGINE_PORT, LISTEN_PORT = '8799', MODE = 'unordered'] = process.argv.slice(2);
const CHUNK = 60_000;
const CHANNEL = {
  ordered: { ordered: true },
  unordered: { ordered: false },
  unreliable: { ordered: false, maxRetransmits: 0 },
}[MODE];
if (!ENGINE_PORT || !CHANNEL) {
  console.error('usage: node bridge.mjs <engine-port> <listen-port> <ordered|unordered|unreliable>');
  process.exit(2);
}

const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page.replace('__MODE__', MODE));
});

new WebSocketServer({ server, path: '/signal' }).on('connection', (signal) => {
  const pc = new ndc.PeerConnection('bridge', { iceServers: [] });
  // Register before creating channels: creating one starts negotiation and emits the offer.
  pc.onLocalDescription((sdp, type) => signal.send(JSON.stringify({ t: 'sdp', sdp, type })));
  pc.onLocalCandidate((candidate, mid) => signal.send(JSON.stringify({ t: 'cand', candidate, mid })));
  const video = pc.createDataChannel('video', CHANNEL);
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  let engine = null;
  let frameId = 0;
  let sent = 0, dropped = 0;
  signal.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'sdp') pc.setRemoteDescription(m.sdp, m.type);
    if (m.t === 'cand' && m.candidate) pc.addRemoteCandidate(m.candidate, m.mid ?? '0');
  });

  // Once both channels are open, join the engine as a viewer and relay.
  let open = 0;
  const onOpen = () => {
    if (++open < 2) return;
    engine = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/stream`);
    engine.binaryType = 'nodebuffer';
    engine.on('message', (data, isBinary) => {
      if (!isBinary) { if (ctl.isOpen()) ctl.sendMessage(data.toString()); return; }
      // Chunk: u32 frameId | u16 index | u16 count | payload.
      const id = frameId++ >>> 0;
      const count = Math.ceil(data.length / CHUNK);
      for (let i = 0; i < count; i++) {
        const body = data.subarray(i * CHUNK, (i + 1) * CHUNK);
        const msg = Buffer.allocUnsafe(8 + body.length);
        msg.writeUInt32LE(id, 0); msg.writeUInt16LE(i, 4); msg.writeUInt16LE(count, 6);
        body.copy(msg, 8);
        if (video.isOpen() && video.sendMessageBinary(msg)) sent++; else dropped++;
      }
    });
    engine.on('close', () => pc.close());
  };
  video.onOpen(onOpen);
  ctl.onOpen(onOpen);
  ctl.onMessage((msg) => {
    if (engine?.readyState === WebSocket.OPEN) engine.send(typeof msg === 'string' ? msg : msg.toString());
  });

  const stats = setInterval(() => {
    const pair = pc.getSelectedCandidatePair?.();
    const rtt = pc.rtt?.();
    console.log(`[bridge ${MODE}] chunks sent ${sent}, send failures ${dropped}, buffered ${video.bufferedAmount?.() ?? 0} B, ` +
      `rtt ${rtt ?? '?'} ms, path ${pair ? `${pair.local?.type}/${pair.local?.transportType}->${pair.remote?.type}` : '?'}`);
    sent = 0; dropped = 0;
  }, 5000);
  const close = () => { clearInterval(stats); engine?.close(); try { pc.close(); } catch {} };
  signal.on('close', close);
  pc.onStateChange((s) => { if (s === 'closed' || s === 'failed') close(); });
});

server.listen(Number(LISTEN_PORT), '0.0.0.0', () =>
  console.log(`[bridge ${MODE}] http://localhost:${LISTEN_PORT}/ -> engine :${ENGINE_PORT} over WebRTC data channel`));
