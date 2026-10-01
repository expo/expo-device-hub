import {
  H264RtpPacketizer,
  PacingHandler,
  PeerConnection,
  RtcpNackResponder,
  RtcpSrReporter,
  RtpPacketizationConfig,
  Video,
  type DescriptionType,
} from "node-datachannel";
import { WebSocket } from "ws";

/**
 * simstream over a WebRTC video track (RTP): one bridge per browser, run in the simstream relay
 * process. The engine is unchanged: the bridge joins its `/stream` WebSocket as a viewer (on
 * loopback) and sends the engine's H.264 frames as RTP, so the browser's own WebRTC stack does
 * jitter buffering, loss recovery (NACK), keyframe requests (PLI) and decoding. On a lossy link this
 * holds up far better than TCP, where one lost packet holds back every frame behind it.
 *
 *   - H264RtpPacketizer splits frames into RTP packets (the engine's AVCC NAL units, with SPS/PPS
 *     from its avcC prepended to keyframes, since RTP carries parameter sets in-band);
 *   - RtcpNackResponder resends packets the browser reports missing;
 *   - PacingHandler spreads each frame's packets out instead of one line-rate burst;
 *   - the playout-delay header extension asks the browser to render as soon as it can.
 *
 * The engine keeps its own rate control: the page acks each frame as it arrives (by RTP timestamp,
 * mapped back to the engine's frame seq here). Settings, acks and pause/resume come over a "ctl"
 * data channel; `signal` carries SDP and ICE candidates.
 */
const PAYLOAD_TYPE = 96;
const PLAYOUT_DELAY_ID = 6;
const HEADER_BYTES = 49;
const PACE_BPS = 300_000_000;
const PACE_INTERVAL_MS = 1;
const MAX_RTP_PAYLOAD = 1200;

/** SPS and PPS NAL units from an avcC box, each with a 4-byte length prefix (the packetizer's framing). */
export function parameterSets(avcC: Buffer): Buffer {
  const nals: Buffer[] = [];
  let o = 5;
  const spsCount = avcC[o++]! & 0x1f;
  for (let i = 0; i < spsCount; i++) {
    const n = avcC.readUInt16BE(o);
    nals.push(avcC.subarray(o + 2, o + 2 + n));
    o += 2 + n;
  }
  const ppsCount = avcC[o++]!;
  for (let i = 0; i < ppsCount; i++) {
    const n = avcC.readUInt16BE(o);
    nals.push(avcC.subarray(o + 2, o + 2 + n));
    o += 2 + n;
  }
  return Buffer.concat(nals.flatMap((nal) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(nal.length);
    return [length, nal];
  }));
}

/** True if a (possibly compound) RTCP packet contains a PLI or FIR. */
export function asksForKeyframe(rtcp: Buffer): boolean {
  for (let o = 0; o + 4 <= rtcp.length;) {
    const format = rtcp[o]! & 0x1f;
    const type = rtcp[o + 1]!;
    if (type === 206 && (format === 1 || format === 4)) return true;
    o += (rtcp.readUInt16BE(o + 2) + 1) * 4;
  }
  return false;
}

/** Bridges one browser (its signaling socket) to the engine on 127.0.0.1:`enginePort`. */
export function bridgeSimstreamRtp(signal: WebSocket, enginePort: number, iceServers: string[]): void {
  const pc = new PeerConnection("simstream-rtp", { iceServers });
  pc.onLocalDescription((sdp, type) => signal.send(JSON.stringify({ t: "sdp", sdp, type })));
  pc.onLocalCandidate((candidate, mid) => signal.send(JSON.stringify({ t: "cand", candidate, mid })));

  // The engine encodes Constrained High, a subset of High; Chrome matches profiles exactly and only
  // offers High (64), so declare that. level-asymmetry lets the stream exceed the level Chrome offers.
  const ssrc = (Math.random() * 2 ** 31) >>> 0;
  const media = new Video("video", "SendOnly");
  media.addH264Codec(PAYLOAD_TYPE, "profile-level-id=64001f;packetization-mode=1;level-asymmetry-allowed=1");
  media.addSSRC(ssrc, "simstream", "simstream", "video");
  media.parseSdpLine(`a=extmap:${PLAYOUT_DELAY_ID} http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`);
  const track = pc.addTrack(media);
  const rtp = new RtpPacketizationConfig(ssrc, "simstream", PAYLOAD_TYPE, 90000);
  rtp.playoutDelayId = PLAYOUT_DELAY_ID;
  rtp.playoutDelayMin = 0;
  rtp.playoutDelayMax = 0;
  const packetizer = new H264RtpPacketizer("Length", rtp, MAX_RTP_PAYLOAD);
  packetizer.addToChain(new RtcpSrReporter(rtp));
  packetizer.addToChain(new RtcpNackResponder(4096));
  packetizer.addToChain(new PacingHandler(PACE_BPS, PACE_INTERVAL_MS));
  track.setMediaHandler(packetizer);
  const ctl = pc.createDataChannel("ctl");

  let engine: WebSocket | null = null;
  let parameterSetNals: Buffer | null = null;
  const pending: string[] = [];
  const seqByRtp = new Map<number, number>(); // RTP timestamp -> engine frame seq, for acks
  const toEngine = (text: string) => {
    if (engine?.readyState === WebSocket.OPEN) engine.send(text);
    else pending.push(text);
  };

  const connectEngine = () => {
    engine = new WebSocket(`ws://127.0.0.1:${enginePort}/stream`);
    engine.binaryType = "nodebuffer";
    engine.on("open", () => {
      for (const text of pending.splice(0)) engine!.send(text);
    });
    engine.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString()) as { t?: string; codec?: string; description?: string };
        if (message.t === "config" && message.codec?.startsWith("avc1") && message.description) {
          parameterSetNals = parameterSets(Buffer.from(message.description, "base64"));
        }
        if (ctl.isOpen()) ctl.sendMessage(data.toString());
        return;
      }
      if (!parameterSetNals || !track.isOpen()) return;
      const isKey = (data[0]! & 1) === 1;
      const seq = data.readUInt32LE(1);
      const captureMs = data.readDoubleLE(5);
      const payload = data.subarray(HEADER_BYTES);
      const timestamp = Math.round(captureMs * 90) >>> 0;
      rtp.timestamp = timestamp;
      seqByRtp.set(timestamp, seq);
      if (seqByRtp.size > 600) seqByRtp.delete(seqByRtp.keys().next().value!);
      track.sendMessageBinary(isKey ? Buffer.concat([parameterSetNals, payload]) : payload);
    });
    engine.on("close", close);
    engine.on("error", close);
  };

  // The engine starts sending as soon as it has a viewer: join once the track and ctl are both open.
  let opened = 0;
  const onOpen = () => {
    if (++opened === 2) connectEngine();
  };
  track.onOpen(onOpen);
  ctl.onOpen(onOpen);
  track.onMessage((message) => {
    if (asksForKeyframe(Buffer.from(message as Buffer))) toEngine('{"t":"keyframe"}');
  });
  ctl.onMessage((message) => {
    const text = typeof message === "string" ? message : Buffer.from(message as Buffer).toString();
    const parsed = JSON.parse(text) as { t?: string; rtp?: number };
    if (parsed.t !== "ack") return toEngine(text);
    // The page acks frames by RTP timestamp; the engine wants its own seq.
    const seq = seqByRtp.get(parsed.rtp!);
    if (seq !== undefined) toEngine(JSON.stringify({ t: "ack", seq }));
  });
  signal.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { t?: string; sdp?: string; type?: string; candidate?: string; mid?: string };
    if (message.t === "sdp" && message.sdp && message.type) pc.setRemoteDescription(message.sdp, message.type as DescriptionType);
    if (message.t === "cand" && message.candidate) pc.addRemoteCandidate(message.candidate, message.mid ?? "0");
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    engine?.close();
    signal.close();
    try { pc.close(); } catch {}
  }
  signal.on("close", close);
  pc.onStateChange((state) => {
    if (state === "closed" || state === "failed") close();
  });
}
