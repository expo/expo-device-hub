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

/** A signaling message from the browser: its SDP answer, or one of its ICE candidates. */
export type SignalMessage =
  | { t: "sdp"; sdp: string; type: DescriptionType }
  | { t: "cand"; candidate: string; mid: string };

const DESCRIPTION_TYPES = new Set<string>(["offer", "answer", "pranswer", "rollback"]);

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** The browser's signaling message, or null if it isn't one. */
export function parseSignalMessage(text: string): SignalMessage | null {
  const message = parseObject(text);
  if (message?.t === "sdp" && typeof message.sdp === "string" && typeof message.type === "string" && DESCRIPTION_TYPES.has(message.type)) {
    return { t: "sdp", sdp: message.sdp, type: message.type as DescriptionType };
  }
  if (message?.t === "cand" && typeof message.candidate === "string" && (message.mid === undefined || message.mid === null || typeof message.mid === "string")) {
    return { t: "cand", candidate: message.candidate, mid: (message.mid as string | null | undefined) ?? "0" };
  }
  return null;
}

/**
 * A message from the page's "ctl" channel, or null if it isn't one. Acks name a frame by RTP
 * timestamp; anything else is a JSON object with a string `t`, passed to the engine as sent (the
 * same messages the WebSocket transport sends it directly).
 */
export function parseControlMessage(text: string): { ack: number } | { engine: string } | null {
  const message = parseObject(text);
  if (typeof message?.t !== "string") return null;
  if (message.t !== "ack") return { engine: text };
  return typeof message.rtp === "number" && Number.isInteger(message.rtp) ? { ack: message.rtp } : null;
}

/**
 * Bridges one browser (its signaling socket) to the engine on 127.0.0.1:`enginePort`.
 *
 * The relay process runs every viewer's bridge and pipe, so nothing a browser sends may throw out of
 * a callback here: an uncaught exception would end the relay and drop every viewer. Each callback
 * catches its own errors and closes only this bridge.
 */
export function bridgeSimstreamRtp(signal: WebSocket, enginePort: number, iceServers: string[]): void {
  let closed = false;
  let pc: PeerConnection | null = null;
  let engine: WebSocket | null = null;
  const pending: string[] = [];
  const toEngine = (text: string) => {
    if (engine?.readyState === WebSocket.OPEN) engine.send(text);
    else pending.push(text);
  };
  function close(code?: number, reason?: string) {
    if (closed) return;
    closed = true;
    engine?.close();
    // A close reason is limited to 123 bytes.
    try { signal.close(code, reason?.slice(0, 120)); } catch { signal.terminate(); }
    try { pc?.close(); } catch {}
  }
  const sendSignal = (message: object) => {
    if (signal.readyState === WebSocket.OPEN) signal.send(JSON.stringify(message));
  };
  /** Ends this bridge on an error, telling the page why when it can. */
  const fail = (error: unknown) => {
    if (closed) return;
    const reason = error instanceof Error ? error.message : String(error);
    sendSignal({ t: "error", message: reason });
    close(1008, reason);
  };
  /** Wraps a callback so whatever it throws ends this bridge instead of the relay. */
  const guard = <Args extends unknown[]>(callback: (...args: Args) => void) => (...args: Args) => {
    if (closed) return;
    try {
      callback(...args);
    } catch (error) {
      fail(error);
    }
  };

  signal.on("close", () => close());
  signal.on("error", () => close());

  try {
    const peer = new PeerConnection("simstream-rtp", { iceServers });
    pc = peer;
    peer.onLocalDescription(guard((sdp, type) => sendSignal({ t: "sdp", sdp, type })));
    peer.onLocalCandidate(guard((candidate, mid) => sendSignal({ t: "cand", candidate, mid })));

    // The engine encodes Constrained High, a subset of High; Chrome matches profiles exactly and only
    // offers High (64), so declare that. level-asymmetry lets the stream exceed the level Chrome offers.
    const ssrc = (Math.random() * 2 ** 31) >>> 0;
    const media = new Video("video", "SendOnly");
    media.addH264Codec(PAYLOAD_TYPE, "profile-level-id=64001f;packetization-mode=1;level-asymmetry-allowed=1");
    media.addSSRC(ssrc, "simstream", "simstream", "video");
    media.parseSdpLine(`a=extmap:${PLAYOUT_DELAY_ID} http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`);
    const track = peer.addTrack(media);
    const rtp = new RtpPacketizationConfig(ssrc, "simstream", PAYLOAD_TYPE, 90000);
    rtp.playoutDelayId = PLAYOUT_DELAY_ID;
    rtp.playoutDelayMin = 0;
    rtp.playoutDelayMax = 0;
    const packetizer = new H264RtpPacketizer("Length", rtp, MAX_RTP_PAYLOAD);
    packetizer.addToChain(new RtcpSrReporter(rtp));
    packetizer.addToChain(new RtcpNackResponder(4096));
    packetizer.addToChain(new PacingHandler(PACE_BPS, PACE_INTERVAL_MS));
    track.setMediaHandler(packetizer);
    const ctl = peer.createDataChannel("ctl");

    let parameterSetNals: Buffer | null = null;
    const seqByRtp = new Map<number, number>(); // RTP timestamp -> engine frame seq, for acks

    const connectEngine = () => {
      const socket = new WebSocket(`ws://127.0.0.1:${enginePort}/stream`);
      engine = socket;
      socket.binaryType = "nodebuffer";
      socket.on("open", guard(() => {
        for (const text of pending.splice(0)) socket.send(text);
      }));
      socket.on("message", guard((data: Buffer, isBinary: boolean) => {
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
      }));
      socket.on("close", () => close());
      socket.on("error", () => close());
    };

    // The engine starts sending as soon as it has a viewer: join once the track and ctl are both open.
    let opened = 0;
    const onOpen = guard(() => {
      if (++opened === 2) connectEngine();
    });
    track.onOpen(onOpen);
    ctl.onOpen(onOpen);
    track.onMessage(guard((message) => {
      if (asksForKeyframe(Buffer.from(message as Buffer))) toEngine('{"t":"keyframe"}');
    }));
    ctl.onMessage(guard((message) => {
      const text = typeof message === "string" ? message : Buffer.from(message as Buffer).toString();
      const parsed = parseControlMessage(text);
      if (!parsed) throw new Error("malformed control message");
      if ("engine" in parsed) return toEngine(parsed.engine);
      // The page acks frames by RTP timestamp; the engine wants its own seq.
      const seq = seqByRtp.get(parsed.ack);
      if (seq !== undefined) toEngine(JSON.stringify({ t: "ack", seq }));
    }));
    signal.on("message", guard((raw) => {
      const message = parseSignalMessage(raw.toString());
      if (!message) throw new Error("malformed signaling message");
      if (message.t === "sdp") peer.setRemoteDescription(message.sdp, message.type);
      else peer.addRemoteCandidate(message.candidate, message.mid);
    }));
    peer.onStateChange(guard((state) => {
      if (state === "closed" || state === "failed") close();
    }));
  } catch (error) {
    fail(error);
  }
}
