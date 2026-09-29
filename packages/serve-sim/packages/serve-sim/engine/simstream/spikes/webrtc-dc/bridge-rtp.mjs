// Spike #6: the simstream engine's stream as a WebRTC video track (RTP) instead of a data channel.
//
//   node bridge-rtp.mjs <engine-port> <listen-port>
//
// The engine is unchanged: for each browser the bridge joins the engine's /stream WebSocket as a
// viewer (on loopback) and sends the engine's H.264 frames as RTP. The browser's own WebRTC stack
// then does jitter buffering, loss recovery (NACK), keyframe requests (PLI) and decoding into a
// <video>. On the sending side:
//   - H264RtpPacketizer splits frames into RTP packets (the engine's AVCC NAL units, with SPS/PPS
//     from its avcC prepended to keyframes, since RTP carries parameter sets in-band);
//   - RtcpNackResponder resends packets the browser reports missing;
//   - PacingHandler spreads each frame's packets out at PACE_MBPS, instead of one line-rate burst
//     (what a data channel does, and what makes big frames either crawl or cause loss);
//   - the playout-delay header extension asks the browser to render as soon as it can.
// The engine keeps its own rate control: the page acks each frame it presents (by RTP timestamp,
// mapped back to the engine's frame seq here). Input, settings and acks go on a "ctl" data channel.
//
// Env: PACE_MBPS (default 120), PACE_INTERVAL_MS (5), DC_STUN, DC_BIND, DC_PORT.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { WebSocket, WebSocketServer } from 'ws';
import ndc from 'node-datachannel';

const [ENGINE_PORT, LISTEN_PORT = '8816'] = process.argv.slice(2);
if (!ENGINE_PORT) {
  console.error('usage: node bridge-rtp.mjs <engine-port> <listen-port>');
  process.exit(2);
}
const PACE_MBPS = Number(process.env.PACE_MBPS || 120);
const PACE_INTERVAL_MS = Number(process.env.PACE_INTERVAL_MS || 5);
const PAYLOAD_TYPE = 96;
const PLAYOUT_DELAY_ID = 6;
const HEADER = 49;

const page = readFileSync(new URL('./page-rtp.html', import.meta.url), 'utf8');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(page);
});

/** SPS and PPS NAL units from an avcC box, each with a 4-byte length prefix (the packetizer's framing). */
function parameterSets(avcC) {
  const out = [];
  let o = 5;
  const sps = avcC[o++] & 0x1f;
  for (let i = 0; i < sps; i++) { const n = avcC.readUInt16BE(o); out.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  const pps = avcC[o++];
  for (let i = 0; i < pps; i++) { const n = avcC.readUInt16BE(o); out.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
  return Buffer.concat(out.flatMap((nal) => { const len = Buffer.alloc(4); len.writeUInt32BE(nal.length); return [len, nal]; }));
}

/** True if a (possibly compound) RTCP packet contains a PLI or FIR. */
function asksForKeyframe(buf) {
  for (let o = 0; o + 4 <= buf.length;) {
    const fmt = buf[o] & 0x1f, pt = buf[o + 1], words = buf.readUInt16BE(o + 2);
    if (pt === 206 && (fmt === 1 || fmt === 4)) return true;
    o += (words + 1) * 4;
  }
  return false;
}

new WebSocketServer({ server, path: '/signal' }).on('connection', (signal) => {
  const rtcConfig = { iceServers: process.env.DC_STUN ? [process.env.DC_STUN] : [] };
  if (process.env.DC_BIND) rtcConfig.bindAddress = process.env.DC_BIND;
  if (process.env.DC_PORT) { rtcConfig.portRangeBegin = Number(process.env.DC_PORT); rtcConfig.portRangeEnd = Number(process.env.DC_PORT); }
  const pc = new ndc.PeerConnection('bridge-rtp', rtcConfig);
  pc.onLocalDescription((sdp, type) => signal.send(JSON.stringify({ t: 'sdp', sdp, type })));
  pc.onLocalCandidate((candidate, mid) => signal.send(JSON.stringify({ t: 'cand', candidate, mid })));

  // The engine encodes Constrained High, a subset of High; Chrome matches profiles exactly and only
  // offers High (64), so declare that. level-asymmetry lets the stream exceed the level Chrome offers.
  const ssrc = (Math.random() * 2 ** 31) >>> 0;
  const media = new ndc.Video('video', 'SendOnly');
  media.addH264Codec(PAYLOAD_TYPE, 'profile-level-id=64001f;packetization-mode=1;level-asymmetry-allowed=1');
  media.addSSRC(ssrc, 'simstream', 'simstream', 'video');
  media.parseSdpLine(`a=extmap:${PLAYOUT_DELAY_ID} http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`);
  const track = pc.addTrack(media);
  const rtp = new ndc.RtpPacketizationConfig(ssrc, 'simstream', PAYLOAD_TYPE, 90000);
  rtp.playoutDelayId = PLAYOUT_DELAY_ID;
  rtp.playoutDelayMin = 0;
  rtp.playoutDelayMax = 0;
  const packetizer = new ndc.H264RtpPacketizer('Length', rtp, 1200);
  packetizer.addToChain(new ndc.RtcpSrReporter(rtp));
  packetizer.addToChain(new ndc.RtcpNackResponder(4096));
  packetizer.addToChain(new ndc.PacingHandler(PACE_MBPS * 1e6, PACE_INTERVAL_MS));
  track.setMediaHandler(packetizer);
  const ctl = pc.createDataChannel('ctl', { ordered: true });

  let engine = null, parameterSetNals = null;
  const pending = [];
  const seqByRtp = new Map();   // RTP timestamp -> engine frame seq, for acks
  const sentAt = new Map();     // engine seq -> { ms, bytes }
  let frames = 0, bytes = 0, keyRequests = 0, legSmall = [], legBig = [];

  const toEngine = (text) => {
    if (engine?.readyState === WebSocket.OPEN) engine.send(text); else pending.push(text);
  };
  const requestKey = () => { keyRequests++; toEngine('{"t":"keyframe"}'); };

  let open = 0;
  const onOpen = () => {
    if (++open < 2) return;
    engine = new WebSocket(`ws://127.0.0.1:${ENGINE_PORT}/stream`);
    engine.binaryType = 'nodebuffer';
    engine.on('open', () => { for (const text of pending.splice(0)) engine.send(text); });
    engine.on('message', (data, isBinary) => {
      if (!isBinary) {
        const m = JSON.parse(data.toString());
        if (m.t === 'config') {
          if (!m.codec.startsWith('avc1')) console.error(`[bridge rtp] engine sent ${m.codec}; this spike carries H.264 only`);
          else parameterSetNals = parameterSets(Buffer.from(m.description, 'base64'));
        }
        try { if (ctl.isOpen()) ctl.sendMessage(data.toString()); } catch {}
        return;
      }
      if (!parameterSetNals || !track.isOpen()) return;
      const isKey = (data[0] & 1) === 1, seq = data.readUInt32LE(1), captureMs = data.readDoubleLE(5);
      const payload = data.subarray(HEADER);
      const frame = isKey ? Buffer.concat([parameterSetNals, payload]) : payload;
      const ts = Math.round(captureMs * 90) >>> 0;
      rtp.timestamp = ts;
      seqByRtp.set(ts, seq);
      if (seqByRtp.size > 600) seqByRtp.delete(seqByRtp.keys().next().value);
      sentAt.set(seq, { ms: performance.now(), bytes: frame.length });
      if (sentAt.size > 600) sentAt.delete(sentAt.keys().next().value);
      try { track.sendMessageBinary(frame); frames++; bytes += frame.length; } catch {}
    });
    engine.on('close', () => { try { pc.close(); } catch {} });
  };
  track.onOpen(onOpen);
  ctl.onOpen(onOpen);
  track.onMessage((msg) => { if (asksForKeyframe(msg)) requestKey(); });

  ctl.onMessage((msg) => {
    const text = typeof msg === 'string' ? msg : msg.toString();
    if (text.startsWith('{"t":"ack"')) {
      // The page acks presented frames by RTP timestamp; the engine wants its own seq.
      const seq = seqByRtp.get(JSON.parse(text).rtp);
      if (seq === undefined) return;
      const s = sentAt.get(seq);
      if (s) (s.bytes > 50_000 ? legBig : legSmall).push(performance.now() - s.ms);
      toEngine(JSON.stringify({ t: 'ack', seq }));
      return;
    }
    toEngine(text);
  });
  signal.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'sdp') pc.setRemoteDescription(m.sdp, m.type);
    if (m.t === 'cand' && m.candidate) pc.addRemoteCandidate(m.candidate, m.mid ?? '0');
  });

  const fmt = (xs) => { if (!xs.length) return '-'; const v = xs.slice().sort((a, b) => a - b);
    return `p50 ${Math.round(v[v.length >> 1])} p95 ${Math.round(v[Math.floor(v.length * 0.95)])} ms (n ${v.length})`; };
  const stats = setInterval(() => {
    const pair = pc.getSelectedCandidatePair?.();
    console.log(`[bridge rtp] frames ${frames}, ${(bytes * 8 / 5e6).toFixed(1)} Mbps, keyframe requests ${keyRequests}, ` +
      `ack leg ${fmt(legSmall)} small / ${fmt(legBig)} big, rtt ${pc.rtt?.() ?? '?'} ms, ` +
      `path ${pair ? `${pair.local?.type}->${pair.remote?.type} ${pair.remote?.address}:${pair.remote?.port}` : '?'}`);
    frames = 0; bytes = 0; keyRequests = 0; legSmall = []; legBig = [];
  }, 5000);
  const close = () => { clearInterval(stats); engine?.close(); try { pc.close(); } catch {} };
  signal.on('close', close);
  pc.onStateChange((s) => { if (s === 'closed' || s === 'failed') close(); });
});

server.listen(Number(LISTEN_PORT), '0.0.0.0', () =>
  console.log(`[bridge rtp] http://localhost:${LISTEN_PORT}/ -> engine :${ENGINE_PORT} as an RTP video track ` +
    `(paced at ${PACE_MBPS} Mbps / ${PACE_INTERVAL_MS} ms)`));
