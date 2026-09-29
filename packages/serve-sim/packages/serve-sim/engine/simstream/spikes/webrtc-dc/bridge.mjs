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
// Tuning (iteration 1): acks on an unreliable channel (cumulative, so a lost one is superseded by
// the next), SCTP delayed-SACK and congestion-control module from the environment.
const ACKS_UNRELIABLE = process.env.DC_ACKS === 'unreliable';
const SCTP = {};
if (process.env.SCTP_SACK_MS) SCTP.delayedSackTime = Number(process.env.SCTP_SACK_MS);
if (process.env.SCTP_CC) SCTP.congestionControlModule = Number(process.env.SCTP_CC);
if (process.env.SCTP_CWND) SCTP.initialCongestionWindow = Number(process.env.SCTP_CWND);
// Retransmission timers: needs node-datachannel rebuilt with these fields exposed (see README note).
if (process.env.SCTP_RTO_MIN) SCTP.minRetransmitTimeout = Number(process.env.SCTP_RTO_MIN);
if (process.env.SCTP_RTO_MAX) SCTP.maxRetransmitTimeout = Number(process.env.SCTP_RTO_MAX);
if (process.env.SCTP_RTO_INIT) SCTP.initialRetransmitTimeout = Number(process.env.SCTP_RTO_INIT);
if (process.env.SCTP_MAX_BURST) SCTP.maxBurst = Number(process.env.SCTP_MAX_BURST);
if (Object.keys(SCTP).length) ndc.setSctpSettings(SCTP);
const CHUNK = 60_000;
// Backpressure: once this much video is queued in the data channel (SCTP can't send it yet, e.g. its
// window collapsed after a loss), stop queueing stale frames: drop deltas, ask the engine for a
// keyframe and resume from it. The WebSocket path gets the same from the engine's backlog handling;
// without it a loss burst turns into seconds of queued video. 0 disables.
const MAX_QUEUE = Number(process.env.DC_MAX_QUEUE ?? 256_000);
const CHANNEL = {
  ordered: { ordered: true },
  unordered: { ordered: false },
  unreliable: { ordered: false, maxRetransmits: 0 },
  nack: { ordered: false, maxRetransmits: 0 },   // unreliable; the page NACKs gaps and we resend (see below)
  ws: {},                                        // control: the page talks to the engine's WebSocket directly
}[MODE];
const NACK = MODE === 'nack';
// Test aid: drop this share of first-time chunk sends (retransmits always go out).
const DROP = Number(process.env.DROP_PCT || 0) / 100;
if (!ENGINE_PORT || !CHANNEL) {
  console.error('usage: node bridge.mjs <engine-port> <listen-port> <ordered|unordered|unreliable>');
  process.exit(2);
}

const page = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page.replaceAll('__MODE__', MODE).replaceAll('__ENGINE_PORT__', ENGINE_PORT));
});

new WebSocketServer({ server, path: '/signal' }).on('connection', (signal) => {
  // Public-path tests: bind ICE to one address and a fixed UDP port (forwarded on the router), and use
  // STUN so the public address is offered; otherwise ICE may pick an overlay path (e.g. Tailscale).
  const rtcConfig = { iceServers: process.env.DC_STUN ? [process.env.DC_STUN] : [] };
  if (process.env.DC_BIND) rtcConfig.bindAddress = process.env.DC_BIND;
  if (process.env.DC_PORT) { rtcConfig.portRangeBegin = Number(process.env.DC_PORT); rtcConfig.portRangeEnd = Number(process.env.DC_PORT); }
  const pc = new ndc.PeerConnection('bridge', rtcConfig);
  // Register before creating channels: creating one starts negotiation and emits the offer.
  pc.onLocalDescription((sdp, type) => signal.send(JSON.stringify({ t: 'sdp', sdp, type })));
  pc.onLocalCandidate((candidate, mid) => signal.send(JSON.stringify({ t: 'cand', candidate, mid })));
  const video = pc.createDataChannel('video', CHANNEL);
  const ctl = pc.createDataChannel('ctl', { ordered: true });
  const ackChannel = ACKS_UNRELIABLE ? pc.createDataChannel('ack', { ordered: false, maxRetransmits: 0 }) : null;
  let engine = null;
  const pending = [];
  // The peer can go away between isOpen() and the send (EPIPE); that ends the session, not the bridge.
  const sendVideo = (msg) => { try { return video.isOpen() && video.sendMessageBinary(msg); } catch { return false; } };
  let frameId = 0;
  // Chunk cache for NACK retransmits: chunkSeq -> message, last ~2 s.
  let chunkSeq = 0;
  const cache = new Map();
  let nacks = 0, resent = 0;
  // Round trip over the WebRTC leg only: frame forwarded -> its ack back from the page (engine seq).
  const forwardedAt = new Map();
  let legSmall = [], legBig = [];
  let sent = 0, dropped = 0, peakBuffered = 0;
  let skipping = false, skippedFrames = 0, lastKeyRequest = 0, lastKeyBytes = 0;
  const requestKey = () => {
    const now = performance.now();
    if (now - lastKeyRequest < 250 || engine?.readyState !== WebSocket.OPEN) return;
    lastKeyRequest = now; engine.send('{"t":"keyframe"}');
  };
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
    engine.on('open', () => { for (const text of pending.splice(0)) engine.send(text); });
    engine.on('message', (data, isBinary) => {
      if (!isBinary) { try { if (ctl.isOpen()) ctl.sendMessage(data.toString()); } catch {} return; }
      if (MAX_QUEUE) {
        const isKey = (data[0] & 1) === 1, queued = video.bufferedAmount();
        // A keyframe can be bigger than the limit on its own: allow for the last one still draining,
        // or resuming on it would immediately trigger the next skip (and keyframe request).
        if (isKey) lastKeyBytes = data.length;
        if (!skipping && !isKey && queued > MAX_QUEUE + lastKeyBytes) skipping = true;
        if (skipping && isKey && queued < MAX_QUEUE / 2) skipping = false;
        if (skipping) { skippedFrames++; requestKey(); return; }
      }
      // Chunk: u32 frameId | u16 index | u16 count | u32 chunkSeq | payload.
      const id = frameId++ >>> 0;
      forwardedAt.set(data.readUInt32LE(1), { ms: performance.now(), bytes: data.length });
      if (forwardedAt.size > 600) forwardedAt.delete(forwardedAt.keys().next().value);
      const count = Math.ceil(data.length / CHUNK);
      for (let i = 0; i < count; i++) {
        const body = data.subarray(i * CHUNK, (i + 1) * CHUNK);
        const msg = Buffer.allocUnsafe(12 + body.length);
        const seq = chunkSeq++ >>> 0;
        msg.writeUInt32LE(id, 0); msg.writeUInt16LE(i, 4); msg.writeUInt16LE(count, 6); msg.writeUInt32LE(seq, 8);
        body.copy(msg, 12);
        if (NACK) { cache.set(seq, msg); if (cache.size > 2000) cache.delete(cache.keys().next().value); }
        if (DROP && Math.random() < DROP) { dropped++; continue; }
        if (sendVideo(msg)) sent++; else dropped++;
        peakBuffered = Math.max(peakBuffered, video.bufferedAmount());
      }
    });
    engine.on('close', () => pc.close());
  };
  video.onOpen(onOpen);
  ctl.onOpen(onOpen);
  const toEngine = (msg) => {
    const text = typeof msg === 'string' ? msg : msg.toString();
    if (text.startsWith('{"t":"ack"')) {
      const f = forwardedAt.get(JSON.parse(text).seq);
      if (f) (f.bytes > 50_000 ? legBig : legSmall).push(performance.now() - f.ms);
    }
    if (NACK && text.startsWith('{"t":"nack"')) {
      // Retransmit requested chunks from the cache; the engine never sees NACKs.
      nacks++;
      for (const seq of JSON.parse(text).seqs) {
        const m = cache.get(seq);
        if (m && !(MAX_QUEUE && video.bufferedAmount() > MAX_QUEUE) && sendVideo(m)) resent++;
      }
      return;
    }
    // The page sends hello/settings as soon as ctl opens, before the engine socket is connected:
    // hold them until it is, or the engine never sees them (and e.g. keeps "soft" transitions).
    if (engine?.readyState === WebSocket.OPEN) engine.send(text); else pending.push(text);
  };
  ctl.onMessage(toEngine);
  ackChannel?.onMessage(toEngine);

  const fmt = (xs) => { if (!xs.length) return '-'; const v = xs.slice().sort((a, b) => a - b);
    return `p50 ${Math.round(v[v.length >> 1])} p95 ${Math.round(v[Math.floor(v.length * 0.95)])} ms (n ${v.length})`; };
  const stats = setInterval(() => {
    const pair = pc.getSelectedCandidatePair?.();
    const rtt = pc.rtt?.();
    console.log(`[bridge ${MODE}] chunks sent ${sent}, send failures ${dropped}, peak buffered ${peakBuffered} B, nacks ${nacks}, resent ${resent}, skipped ${skippedFrames} frames, ` +
      `leg ${fmt(legSmall)} small / ${fmt(legBig)} big, rtt ${rtt ?? '?'} ms, path ${pair ? `${pair.local?.type}/${pair.local?.transportType}->${pair.remote?.type} ${pair.remote?.address}:${pair.remote?.port}` : '?'}`);
    sent = 0; dropped = 0; peakBuffered = 0; nacks = 0; resent = 0; skippedFrames = 0; legSmall = []; legBig = [];
  }, 5000);
  const close = () => { clearInterval(stats); engine?.close(); try { pc.close(); } catch {} };
  signal.on('close', close);
  pc.onStateChange((s) => { if (s === 'closed' || s === 'failed') close(); });
});

server.listen(Number(LISTEN_PORT), '0.0.0.0', () =>
  console.log(`[bridge ${MODE}] http://localhost:${LISTEN_PORT}/ -> engine :${ENGINE_PORT} over WebRTC data channel` +
    ` (acks ${ACKS_UNRELIABLE ? 'unreliable' : 'on ctl'}, max queue ${MAX_QUEUE} B, sctp ${JSON.stringify(SCTP)})`));
