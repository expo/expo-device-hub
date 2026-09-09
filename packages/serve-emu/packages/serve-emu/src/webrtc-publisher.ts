import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type nodeDataChannel from "node-datachannel";
import type {
  H264RtpPacketizer,
  PeerConnection,
  RtcpNackResponder,
  RtcpSrReporter,
  RtpPacketizationConfig,
  Track,
} from "node-datachannel";
import type { VideoFrame } from "./scrcpy.ts";
import type { StreamSettings, WebRtcIceServer } from "./stream-settings.ts";
import { WebRtcSignalingError, type WebRtcAnswer, type WebRtcOffer } from "./webrtc-signaling.ts";

type NodeDataChannel = typeof nodeDataChannel;
type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive";

export type WebRtcPublisherOptions = {
  settings: Extract<StreamSettings, { transport: "webrtc" }>;
  onKeyframeRequest: (reason: string) => void;
};

export type WebRtcFrameDelivery = {
  /** At least one peer accepted this frame into its native media track. */
  accepted: boolean;
  /** At least one live peer still needs a keyframe after this delivery. */
  awaitingKeyFrame: boolean;
};

export type WebRtcPublisherSessionStats = {
  sessionId: string;
  state: string;
  iceState: string;
  connected: boolean;
  /** H.264 frames accepted by the native media track. */
  submittedFrames: number;
  /** Frames rejected while waiting for a keyframe or by native backpressure. */
  publisherDroppedFrames: number;
  /** H.264 payload bytes accepted by the native media track; excludes RTP transport overhead. */
  payloadBytesSubmitted: number;
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  localCandidateTransport: string | null;
  remoteCandidateTransport: string | null;
  path: "direct" | "relay" | "unknown";
};

type H264Media = { payloadType: number; mid: string };

const requireModule = createRequire(import.meta.url);
const RTP_CLOCK_RATE = 90_000;
const ICE_GATHERING_TIMEOUT_MS = 3_000;
const CONNECTION_TIMEOUT_MS = 10_000;
const DISCONNECTED_GRACE_MS = 10_000;
const MAX_CANCELLED_SESSION_IDS = 64;

let loggerInitialized = false;
let nativeRepairPromise: Promise<void> | null = null;

function randomSsrc(): number {
  return Math.floor(1 + Math.random() * 0x7ffffffe);
}

function icePathForCandidateTypes(
  local: string | null,
  remote: string | null,
): WebRtcPublisherSessionStats["path"] {
  if (local === null || remote === null) return "unknown";
  const types = [local.toLowerCase(), remote.toLowerCase()];
  if (types.includes("relay")) return "relay";
  const directTypes = new Set(["host", "srflx", "prflx"]);
  return types.every((type) => directTypes.has(type)) ? "direct" : "unknown";
}

function sdpEol(sdp: string): "\r\n" | "\n" {
  return sdp.includes("\r\n") ? "\r\n" : "\n";
}

function hasPacketizationMode1(fmtp: string): boolean {
  return /(?:^|;)\s*packetization-mode=1(?:\s*;|$)/i.test(fmtp);
}

// The browser (offerer) owns payload-type numbering. RTP we send must use an
// H.264 payload type from the offer, and libdatachannel's packetizer emits
// FU-A fragments, so packetization-mode=1 is mandatory.
export function selectH264Media(offerSdp: string): H264Media {
  let sessionDirection: MediaDirection = "sendrecv";
  let sawMediaSection = false;
  let section: {
    mid: string | null;
    direction: MediaDirection;
    offeredPayloadTypes: Set<string>;
    h264PayloadTypes: number[];
    fmtpByPayloadType: Map<number, string>;
  } | null = null;
  const candidates: H264Media[] = [];

  const finishSection = () => {
    if (!section?.mid || section.direction === "sendonly" || section.direction === "inactive") return;
    const compatiblePayloadTypes = section.h264PayloadTypes.filter((payloadType) =>
      hasPacketizationMode1(section!.fmtpByPayloadType.get(payloadType) ?? "")
    );
    if (compatiblePayloadTypes.length === 0) return;

    const score = (payloadType: number): number => {
      const fmtp = section!.fmtpByPayloadType.get(payloadType) ?? "";
      const profile = /profile-level-id=([0-9a-f]{6})/i.exec(fmtp)?.[1]?.toLowerCase();
      if (profile?.startsWith("42e0")) return 2;
      if (profile?.startsWith("42")) return 1;
      return 0;
    };
    const payloadType = compatiblePayloadTypes.reduce((best, pt) =>
      score(pt) > score(best) ? pt : best
    );
    candidates.push({ payloadType, mid: section.mid });
  };

  for (const line of offerSdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      finishSection();
      sawMediaSection = true;
      const parts = line.slice(2).trim().split(/\s+/);
      const port = parts[1]?.split("/", 1)[0];
      section = parts[0] === "video" && port !== "0"
        ? {
            mid: null,
            direction: sessionDirection,
            offeredPayloadTypes: new Set(parts.slice(3)),
            h264PayloadTypes: [],
            fmtpByPayloadType: new Map(),
          }
        : null;
      continue;
    }

    const directionLine = /^a=(sendrecv|sendonly|recvonly|inactive)$/.exec(line);
    if (!sawMediaSection && directionLine) {
      sessionDirection = directionLine[1] as MediaDirection;
    }
    if (!section) continue;

    const midLine = /^a=mid:(\S+)/.exec(line);
    if (midLine) section.mid = midLine[1]!;

    if (directionLine) section.direction = directionLine[1] as MediaDirection;

    const rtpmap = /^a=rtpmap:(\d+) H264\/90000/i.exec(line);
    if (rtpmap && section.offeredPayloadTypes.has(rtpmap[1]!)) {
      section.h264PayloadTypes.push(Number(rtpmap[1]));
    }

    const fmtp = /^a=fmtp:(\d+)\s+(.+)$/.exec(line);
    if (fmtp && section.offeredPayloadTypes.has(fmtp[1]!)) {
      section.fmtpByPayloadType.set(Number(fmtp[1]), fmtp[2]!.toLowerCase());
    }
  }
  finishSection();

  const selected = candidates[0];
  if (!selected) {
    throw new WebRtcSignalingError(
      "WebRTC offer does not include receivable H.264 packetization-mode=1 video",
      400,
      "unsupported_offer",
    );
  }
  return selected;
}

function sectionForMid(lines: string[], mid: string): { start: number; end: number; midIndex: number } | null {
  let sectionStart = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith("m=")) sectionStart = index;
    if (line === `a=mid:${mid}` && sectionStart !== -1) {
      let sectionEnd = lines.length;
      for (let scan = index + 1; scan < lines.length; scan++) {
        if (lines[scan]!.startsWith("m=")) {
          sectionEnd = scan;
          break;
        }
      }
      return { start: sectionStart, end: sectionEnd, midIndex: index };
    }
  }
  return null;
}

export function injectVideoSsrc(sdp: string, mid: string, ssrc: number): string {
  const eol = sdpEol(sdp);
  const lines = sdp.split(/\r?\n/);
  const section = sectionForMid(lines, mid);
  if (!section) {
    throw new Error(`WebRTC answer does not include the selected video mid "${mid}"`);
  }
  const ssrcPrefix = `a=ssrc:${ssrc} `;
  if (lines.slice(section.start, section.end).some((line) => line.startsWith(ssrcPrefix))) return sdp;
  lines.splice(section.midIndex + 1, 0, `a=ssrc:${ssrc} cname:serve-emu`);
  return lines.join(eol);
}

function iceUrlsForNodeDataChannel(servers: WebRtcIceServer[]): string[] {
  const urls: string[] = [];
  for (const server of servers) {
    for (const url of server.urls) {
      if (/^turns?:/i.test(url) && server.username && server.credential && !url.includes("@")) {
        const schemeMatch = /^(turns?:)/i.exec(url);
        if (!schemeMatch) {
          urls.push(url);
          continue;
        }
        const scheme = schemeMatch[1]!;
        const rest = url.slice(scheme.length);
        urls.push(
          `${scheme}${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@${rest}`,
        );
      } else {
        urls.push(url);
      }
    }
  }
  return urls;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMissingNativeBindingError(err: unknown): boolean {
  const message = errorMessage(err);
  return message.includes("node_datachannel.node") || message.includes("build/Release");
}

function nodeDataChannelPackageDir(): string {
  let dir = dirname(requireModule.resolve("node-datachannel"));
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate node-datachannel package root");
}

function requireNativeNodeDataChannel(): NodeDataChannel {
  return requireModule(
    join(nodeDataChannelPackageDir(), "build", "Release", "node_datachannel.node"),
  ) as NodeDataChannel;
}

function runPrebuildInstall(packageDir: string): Promise<void> {
  const packageRequire = createRequire(join(packageDir, "package.json"));
  const prebuildInstallBin = packageRequire.resolve("prebuild-install/bin.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [prebuildInstallBin, "-r", "napi"], {
      cwd: packageDir,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `prebuild-install exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
        ),
      );
    });
  });
}

async function loadNodeDataChannel(): Promise<NodeDataChannel> {
  try {
    return requireNativeNodeDataChannel();
  } catch (err) {
    if (!isMissingNativeBindingError(err)) throw err;
    const packageDir = nodeDataChannelPackageDir();
    if (!nativeRepairPromise) {
      console.warn(
        "node-datachannel native binding is missing; attempting to download the prebuilt N-API binary...",
      );
      nativeRepairPromise = runPrebuildInstall(packageDir);
    }
    try {
      await nativeRepairPromise;
      return requireNativeNodeDataChannel();
    } catch (repairErr) {
      throw new Error(
        `node-datachannel native binding is missing and automatic repair failed. ` +
          `Run "bun pm trust node-datachannel" and "bun install", then retry. ` +
          `Original error: ${errorMessage(err)}. Repair error: ${errorMessage(repairErr)}`,
      );
    }
  }
}

export async function createWebRtcPublisher(options: WebRtcPublisherOptions): Promise<WebRtcPublisher> {
  const ndc = await loadNodeDataChannel();
  if (!loggerInitialized) {
    loggerInitialized = true;
    ndc.initLogger("Warning");
  }
  return new WebRtcPublisher(ndc, options);
}

export class WebRtcPublisher {
  private nextPeerId = 1;
  private readonly peers = new Map<string, WebRtcPeer>();
  private readonly cancelledSessionIds = new Set<string>();
  private readonly cancelledSessionIdOrder: string[] = [];
  private pendingSessionId: string | null = null;

  constructor(
    private readonly ndc: NodeDataChannel,
    private readonly options: WebRtcPublisherOptions,
  ) {}

  get activePeerCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) {
      if (peer.connected) count++;
    }
    return count;
  }

  async handleOffer(offer: WebRtcOffer): Promise<WebRtcAnswer> {
    if (this.cancelledSessionIds.has(offer.sessionId)) {
      throw new WebRtcSignalingError(
        "WebRTC session was cancelled",
        409,
        "webrtc_session_cancelled",
      );
    }
    if (this.pendingSessionId) {
      throw new WebRtcSignalingError(
        "WebRTC signaling already in progress",
        409,
        "webrtc_session_busy",
      );
    }
    this.pendingSessionId = offer.sessionId;

    let peer: WebRtcPeer | null = null;
    try {
      if (this.peers.has(offer.sessionId)) {
        throw new WebRtcSignalingError(
          "WebRTC session ID is already active",
          409,
          "webrtc_session_active",
        );
      }

      peer = new WebRtcPeer({
        id: this.nextPeerId++,
        sessionId: offer.sessionId,
        ndc: this.ndc,
        settings: this.options.settings,
        onKeyframeRequest: this.options.onKeyframeRequest,
        onClose: (closedPeer) => {
          if (this.peers.get(closedPeer.sessionId) === closedPeer) this.peers.delete(closedPeer.sessionId);
        },
      });
      this.peers.set(offer.sessionId, peer);
      const answer = await peer.answer(offer);
      if (peer.closed) throw new Error("WebRTC peer closed before answer was created");
      this.options.onKeyframeRequest("WebRTC peer opened");
      return answer;
    } catch (err) {
      peer?.close();
      throw err;
    } finally {
      if (this.pendingSessionId === offer.sessionId) this.pendingSessionId = null;
    }
  }

  closeSession(sessionId: string): void {
    this.rememberCancelledSession(sessionId);
    this.peers.get(sessionId)?.close();
  }

  sendFrame(frame: VideoFrame, config: Buffer | null): WebRtcFrameDelivery {
    if (this.peers.size === 0) {
      return { accepted: false, awaitingKeyFrame: false };
    }
    const payload = frame.isKey && config ? Buffer.concat([config, frame.data]) : frame.data;
    let accepted = false;
    for (const peer of this.peers.values()) {
      if (peer.sendFrame(payload, frame.isKey)) accepted = true;
    }
    return {
      accepted,
      awaitingKeyFrame: Array.from(this.peers.values()).some(
        (peer) => peer.needsKeyFrame,
      ),
    };
  }

  resetVideoSource(): void {
    for (const peer of this.peers.values()) peer.resetVideoSource();
  }

  statsForSession(sessionId: string): WebRtcPublisherSessionStats | null {
    return this.peers.get(sessionId)?.statsSnapshot() ?? null;
  }

  snapshot() {
    return {
      peers: this.peers.size,
      activePeers: this.activePeerCount,
      signalingPending: this.pendingSessionId !== null,
      detail: Array.from(this.peers.values(), (peer) => peer.snapshot()),
    };
  }

  close(): void {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
    this.cancelledSessionIds.clear();
    this.cancelledSessionIdOrder.length = 0;
    this.pendingSessionId = null;
  }

  private rememberCancelledSession(sessionId: string): void {
    if (this.cancelledSessionIds.has(sessionId)) return;
    this.cancelledSessionIds.add(sessionId);
    this.cancelledSessionIdOrder.push(sessionId);
    if (this.cancelledSessionIdOrder.length <= MAX_CANCELLED_SESSION_IDS) return;
    const oldest = this.cancelledSessionIdOrder.shift();
    if (oldest) this.cancelledSessionIds.delete(oldest);
  }
}

class WebRtcPeer {
  readonly id: number;
  readonly sessionId: string;
  readonly pc: PeerConnection;
  closed = false;
  private isConnected = false;
  private wasConnected = false;
  private track: Track | null = null;
  private rtpConfig: RtpPacketizationConfig | null = null;
  private packetizer: H264RtpPacketizer | null = null;
  private nackResponder: RtcpNackResponder | null = null;
  private srReporter: RtcpSrReporter | null = null;
  private trackOpen = false;
  private awaitingKeyFrame = true;
  private sentFrames = 0;
  private droppedFrames = 0;
  private payloadBytesSent = 0;
  private lastFrameMs = 0;
  private lastState = "new";
  private lastIceState = "new";
  private lastError: string | null = null;
  private readonly createdMs = performance.now();
  private lastRtpTicks = 0;
  private selectedMid: string | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null;

  get connected(): boolean {
    return !this.closed && this.isConnected;
  }

  get needsKeyFrame(): boolean {
    return !this.closed && this.awaitingKeyFrame;
  }

  constructor(
    private readonly params: {
      id: number;
      sessionId: string;
      ndc: NodeDataChannel;
      settings: Extract<StreamSettings, { transport: "webrtc" }>;
      onKeyframeRequest: (reason: string) => void;
      onClose: (peer: WebRtcPeer) => void;
    },
  ) {
    this.id = params.id;
    this.sessionId = params.sessionId;
    // The browser is always the offerer. Local auto-negotiation can otherwise
    // wedge the peer in have-local-offer before the browser offer is applied.
    this.pc = new params.ndc.PeerConnection(`serve-emu-${params.id}`, {
      iceServers: iceUrlsForNodeDataChannel(params.settings.iceServers),
      iceTransportPolicy: params.settings.iceTransportPolicy,
      forceMediaTransport: true,
      disableAutoNegotiation: true,
    });

    this.pc.onTrack((track) => this.attachTrack(track));
    this.pc.onStateChange((state) => {
      this.lastState = state;
      if (state === "failed" || state === "closed") {
        this.close();
      } else {
        this.reconcileConnectivity();
      }
    });
    this.pc.onIceStateChange((state) => {
      this.lastIceState = state;
      if (state === "failed" || state === "closed") {
        this.close();
      } else {
        this.reconcileConnectivity();
      }
    });
  }

  async answer(offer: WebRtcOffer): Promise<WebRtcAnswer> {
    const { payloadType, mid } = selectH264Media(offer.sdp);
    this.selectedMid = mid;
    const ssrc = randomSsrc();
    this.rtpConfig = new this.params.ndc.RtpPacketizationConfig(
      ssrc,
      "serve-emu",
      payloadType,
      RTP_CLOCK_RATE,
    );
    const packetizer = new this.params.ndc.H264RtpPacketizer("StartSequence", this.rtpConfig);
    const srReporter = new this.params.ndc.RtcpSrReporter(this.rtpConfig);
    const nackResponder = new this.params.ndc.RtcpNackResponder();
    packetizer.addToChain(srReporter);
    srReporter.addToChain(nackResponder);
    this.packetizer = packetizer;
    this.srReporter = srReporter;
    this.nackResponder = nackResponder;
    // setRemoteDescription reciprocates the offer's recvonly video m-line and
    // emits the SendOnly track we publish on via onTrack.
    try {
      this.pc.setRemoteDescription(offer.sdp, "offer");
    } catch {
      throw new WebRtcSignalingError("Invalid WebRTC offer SDP", 400, "invalid_offer");
    }
    const localDescription = await this.createLocalAnswer();
    await this.waitForIceGathering();
    const finalDescription = this.pc.localDescription() ?? localDescription;
    if (!finalDescription?.sdp) throw new Error("WebRTC answer was not created");
    this.armConnectionDeadline();
    // libdatachannel omits a=ssrc for the reciprocated track; browsers then
    // silently discard RTP packets because they cannot route the SSRC.
    return {
      type: finalDescription.type,
      sdp: injectVideoSsrc(finalDescription.sdp, mid, ssrc),
    };
  }

  private attachTrack(track: Track): void {
    if (this.closed) {
      try {
        track.close();
      } catch {}
      return;
    }
    let trackMid: string;
    try {
      trackMid = track.mid();
    } catch (err) {
      this.lastError = errorMessage(err);
      try {
        track.close();
      } catch {}
      return;
    }
    if (this.selectedMid && trackMid !== this.selectedMid) {
      try {
        track.close();
      } catch {}
      return;
    }
    if (this.track) {
      try {
        track.close();
      } catch {}
      return;
    }
    this.track = track;
    if (this.packetizer) track.setMediaHandler(this.packetizer);
    track.onOpen(() => {
      this.trackOpen = true;
      this.awaitingKeyFrame = true;
      this.params.onKeyframeRequest("WebRTC track opened");
    });
    track.onClosed(() => this.close());
    track.onError((err) => {
      this.lastError = err;
      this.close();
    });
  }

  sendFrame(payload: Buffer, isKeyFrame: boolean): boolean {
    const track = this.track;
    if (
      this.closed ||
      !track ||
      !this.rtpConfig ||
      !this.trackOpen ||
      !track.isOpen()
    ) {
      return false;
    }
    if (this.awaitingKeyFrame) {
      if (!isKeyFrame) {
        this.droppedFrames++;
        return false;
      }
      this.awaitingKeyFrame = false;
    }

    const elapsedMs = performance.now() - this.createdMs;
    this.lastRtpTicks = Math.max(this.lastRtpTicks + 1, Math.round(elapsedMs * 90));
    this.rtpConfig.timestamp = this.lastRtpTicks >>> 0;

    try {
      if (track.sendMessageBinary(payload)) {
        this.sentFrames++;
        this.payloadBytesSent += payload.byteLength;
        this.lastFrameMs = Date.now();
        return true;
      } else {
        this.droppedFrames++;
        this.awaitingKeyFrame = true;
        this.params.onKeyframeRequest("WebRTC peer backpressure");
        return false;
      }
    } catch (err) {
      this.lastError = errorMessage(err);
      this.close();
      return false;
    }
  }

  resetVideoSource(): void {
    this.awaitingKeyFrame = true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.connectionTimer) clearTimeout(this.connectionTimer);
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.isConnected = false;
    this.connectionTimer = null;
    this.disconnectedTimer = null;
    try {
      this.track?.close();
    } catch {}
    try {
      this.pc.close();
    } catch {}
    this.params.onClose(this);
  }

  snapshot() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      state: this.lastState,
      iceState: this.lastIceState,
      connected: this.connected,
      trackOpen: this.trackOpen,
      sentFrames: this.sentFrames,
      droppedFrames: this.droppedFrames,
      awaitingKeyFrame: this.awaitingKeyFrame,
      lastFrameAt: this.lastFrameMs > 0 ? new Date(this.lastFrameMs).toISOString() : null,
      lastError: this.lastError,
    };
  }

  statsSnapshot(): WebRtcPublisherSessionStats {
    let selectedPair: ReturnType<PeerConnection["getSelectedCandidatePair"]> = null;
    try {
      selectedPair = this.pc.getSelectedCandidatePair();
    } catch {}
    const localCandidateType = selectedPair?.local.type ?? null;
    const remoteCandidateType = selectedPair?.remote.type ?? null;
    const path = icePathForCandidateTypes(localCandidateType, remoteCandidateType);
    return {
      sessionId: this.sessionId,
      state: this.lastState,
      iceState: this.lastIceState,
      connected: this.connected,
      submittedFrames: this.sentFrames,
      publisherDroppedFrames: this.droppedFrames,
      payloadBytesSubmitted: this.payloadBytesSent,
      localCandidateType,
      remoteCandidateType,
      localCandidateTransport: selectedPair?.local.transportType ?? null,
      remoteCandidateTransport: selectedPair?.remote.transportType ?? null,
      path,
    };
  }

  private reconcileConnectivity(): void {
    const connected =
      this.lastState === "connected" &&
      (this.lastIceState === "connected" || this.lastIceState === "completed");
    this.isConnected = connected;
    if (connected) {
      this.wasConnected = true;
      if (this.connectionTimer) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
      this.clearDisconnectedDeadline();
    } else if (this.wasConnected) {
      this.armDisconnectedDeadline();
    }
  }

  private armConnectionDeadline(): void {
    if (this.closed || this.isConnected || this.connectionTimer) return;
    this.connectionTimer = setTimeout(() => {
      this.connectionTimer = null;
      if (this.closed || this.isConnected) return;
      this.lastError = "WebRTC peer did not connect before deadline";
      this.close();
    }, CONNECTION_TIMEOUT_MS);
    this.connectionTimer.unref?.();
  }

  private armDisconnectedDeadline(): void {
    if (this.closed || this.disconnectedTimer) return;
    this.disconnectedTimer = setTimeout(() => {
      this.disconnectedTimer = null;
      if (this.closed || this.isConnected) return;
      this.lastError = "WebRTC peer remained disconnected";
      this.close();
    }, DISCONNECTED_GRACE_MS);
    this.disconnectedTimer.unref?.();
  }

  private clearDisconnectedDeadline(): void {
    if (this.disconnectedTimer) clearTimeout(this.disconnectedTimer);
    this.disconnectedTimer = null;
  }

  private createLocalAnswer(): Promise<{ type: string; sdp: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Timed out creating WebRTC answer"));
      }, ICE_GATHERING_TIMEOUT_MS);
      this.pc.onLocalDescription((sdp, type) => {
        clearTimeout(timeout);
        resolve({ type, sdp });
      });
      this.pc.setLocalDescription("answer");
    });
  }

  private waitForIceGathering(): Promise<void> {
    return new Promise((resolve) => {
      if (this.pc.gatheringState() === "complete") {
        resolve();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timeout = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
      this.pc.onGatheringStateChange((state) => {
        if (state !== "complete") return;
        clearTimeout(timeout);
        finish();
      });
    });
  }

}
