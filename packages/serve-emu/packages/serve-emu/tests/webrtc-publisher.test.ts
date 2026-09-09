import { describe, expect, test } from "bun:test";
import type nodeDataChannel from "node-datachannel";
import { injectVideoSsrc, selectH264Media, WebRtcPublisher } from "../src/webrtc-publisher.ts";
import { WebRtcSignalingError } from "../src/webrtc-signaling.ts";

const OFFER_SDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 109",
  "a=mid:video0",
  "a=recvonly",
  "a=rtpmap:109 H264/90000",
  "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
].join("\r\n");

const ANSWER_SDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 109",
  "a=mid:video0",
  "a=sendonly",
].join("\r\n");

class FakeMediaHandler {
  addToChain(_handler: FakeMediaHandler): void {}
}

class FakeRtpPacketizationConfig {
  timestamp = 0;

  constructor(
    readonly ssrc: number,
    readonly cname: string,
    readonly payloadType: number,
    readonly clockRate: number,
  ) {}
}

class FakeTrack {
  readonly sendResults: boolean[] = [];

  mid(): string {
    return "video0";
  }
  close(): void {}
  sendMessageBinary(): boolean {
    return this.sendResults.shift() ?? true;
  }
  isOpen(): boolean {
    return true;
  }
  onOpen(cb: () => void): void {
    cb();
  }
  onClosed(_cb: () => void): void {}
  onError(_cb: (err: string) => void): void {}
  setMediaHandler(_handler: FakeMediaHandler): void {}
}

class FakePeerConnection {
  private localDescriptionCallback: ((sdp: string, type: string) => void) | null = null;
  private trackCallback: ((track: FakeTrack) => void) | null = null;
  private stateCallback: ((state: string) => void) | null = null;
  private iceStateCallback: ((state: string) => void) | null = null;
  private readonly answerDelayMs: number;
  readonly track = new FakeTrack();
  selectedCandidatePair: {
    local: {
      address: string;
      port: number;
      type: string;
      transportType: string;
      candidate: string;
      mid: string;
      priority: number;
    };
    remote: {
      address: string;
      port: number;
      type: string;
      transportType: string;
      candidate: string;
      mid: string;
      priority: number;
    };
  } | null = null;

  constructor(_label: string, config: { answerDelayMs?: number } = {}) {
    this.answerDelayMs = config.answerDelayMs ?? 0;
  }

  onTrack(cb: (track: FakeTrack) => void): void {
    this.trackCallback = cb;
  }
  onDataChannel(_cb: unknown): void {}
  onStateChange(cb: (state: string) => void): void {
    this.stateCallback = cb;
  }
  onIceStateChange(cb: (state: string) => void): void {
    this.iceStateCallback = cb;
  }
  onGatheringStateChange(_cb: (state: string) => void): void {}
  setRemoteDescription(_sdp: string, _type: string): void {
    this.trackCallback?.(this.track);
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.localDescriptionCallback = cb;
  }
  setLocalDescription(type: string): void {
    setTimeout(() => this.localDescriptionCallback?.(ANSWER_SDP, type), this.answerDelayMs);
  }
  gatheringState(): string {
    return "complete";
  }
  localDescription(): { type: string; sdp: string } {
    return { type: "answer", sdp: ANSWER_SDP };
  }
  getSelectedCandidatePair() {
    return this.selectedCandidatePair;
  }
  close(): void {}
  emitState(state: string): void {
    this.stateCallback?.(state);
  }
  emitIceState(state: string): void {
    this.iceStateCallback?.(state);
  }
}

function fakeNodeDataChannel(answerDelayMs = 0): typeof nodeDataChannel {
  return {
    PeerConnection: class extends FakePeerConnection {
      constructor(label: string) {
        super(label, { answerDelayMs });
      }
    },
    RtpPacketizationConfig: FakeRtpPacketizationConfig,
    H264RtpPacketizer: FakeMediaHandler,
    RtcpSrReporter: FakeMediaHandler,
    RtcpNackResponder: FakeMediaHandler,
  } as unknown as typeof nodeDataChannel;
}

describe("WebRTC publisher SDP helpers", () => {
  test("selects a browser-offered H.264 packetization-mode=1 payload type", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96 110 109",
          "a=mid:video0",
          "a=rtpmap:96 VP8/90000",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "video0" });
  });

  test("prefers constrained baseline H.264 when multiple compatible payloads exist", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 111 109",
          "a=mid:0",
          "a=rtpmap:111 H264/90000",
          "a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "0" });
  });

  test("keeps H.264 payload selection scoped to the selected video mid", () => {
    expect(
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 111",
          "a=mid:video0",
          "a=recvonly",
          "a=rtpmap:111 H264/90000",
          "a=fmtp:111 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
          "m=video 9 UDP/TLS/RTP/SAVPF 109",
          "a=mid:video1",
          "a=recvonly",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      ),
    ).toEqual({ payloadType: 109, mid: "video1" });
  });

  test("rejects offers without packetization-mode=1 H.264 video", () => {
    expect(() =>
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 110",
          "a=mid:video0",
          "a=rtpmap:110 H264/90000",
          "a=fmtp:110 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f",
        ].join("\r\n"),
      ),
    ).toThrow("WebRTC offer does not include receivable H.264 packetization-mode=1 video");
  });

  test("rejects disabled and send-only H.264 media sections", () => {
    for (const mediaLines of [
      ["m=video 0 UDP/TLS/RTP/SAVPF 109", "a=mid:video0"],
      ["m=video 0/2 UDP/TLS/RTP/SAVPF 109", "a=mid:video0"],
      ["a=sendonly", "m=video 9 UDP/TLS/RTP/SAVPF 109", "a=mid:video0"],
    ]) {
      expect(() =>
        selectH264Media(
          [
            "v=0",
            ...mediaLines,
            "a=rtpmap:109 H264/90000",
            "a=fmtp:109 packetization-mode=1;profile-level-id=42e01f",
          ].join("\r\n"),
        )
      ).toThrow(WebRtcSignalingError);
    }
  });

  test("ignores H.264 payload declarations absent from the media line", () => {
    expect(() =>
      selectH264Media(
        [
          "v=0",
          "m=video 9 UDP/TLS/RTP/SAVPF 96",
          "a=mid:video0",
          "a=recvonly",
          "a=rtpmap:109 H264/90000",
          "a=fmtp:109 packetization-mode=1;profile-level-id=42e01f",
        ].join("\r\n"),
      )
    ).toThrow(WebRtcSignalingError);
  });

  test("injects the selected SSRC into the matching video section", () => {
    const answer = [
      "v=0",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:audio0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=sendonly",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111",
        "a=mid:audio0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=sendonly",
      ].join("\r\n"),
    );
  });

  test("adds the exact packetizer SSRC even when other SSRC lines exist", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:9999 cname:old",
    ].join("\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(
      [
        "v=0",
        "m=video 9 UDP/TLS/RTP/SAVPF 109",
        "a=mid:video0",
        "a=ssrc:1234 cname:serve-emu",
        "a=ssrc:9999 cname:old",
      ].join("\n"),
    );
  });

  test("leaves SDP unchanged when the exact SSRC is already present", () => {
    const answer = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 109",
      "a=mid:video0",
      "a=ssrc:1234 cname:serve-emu",
    ].join("\r\n");

    expect(injectVideoSsrc(answer, "video0", 1234)).toBe(answer);
  });

  test("throws when the answer does not contain the selected video mid", () => {
    expect(() => injectVideoSsrc("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 109\r\na=mid:other", "video0", 1234))
      .toThrow('WebRTC answer does not include the selected video mid "video0"');
  });
});

describe("WebRTC publisher signaling", () => {
  test("rejects concurrent offers, including duplicate session IDs", async () => {
    const publisher = new WebRtcPublisher(fakeNodeDataChannel(10), {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [{ urls: ["stun:stun.example:3478"] }],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    const sessionId = "00000000-0000-4000-8000-000000000000";
    const first = publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
    try {
      await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
      throw new Error("Expected duplicate offer to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRtcSignalingError);
      expect((err as WebRtcSignalingError).status).toBe(409);
      expect((err as WebRtcSignalingError).code).toBe("webrtc_session_busy");
    }
    await expect(first).resolves.toMatchObject({ type: "answer" });
    publisher.close();
  });

  test("rejects reuse of an active session ID without closing the peer", async () => {
    const publisher = new WebRtcPublisher(fakeNodeDataChannel(), {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    const sessionId = "00000000-0000-4000-8000-000000000000";
    await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });

    try {
      await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
      throw new Error("Expected active session reuse to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRtcSignalingError);
      expect((err as WebRtcSignalingError).code).toBe("webrtc_session_active");
    }
    expect(publisher.snapshot().peers).toBe(1);
    publisher.close();
  });

  test("rejects an offer when its close arrived first", async () => {
    const publisher = new WebRtcPublisher(fakeNodeDataChannel(), {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    const sessionId = "00000000-0000-4000-8000-000000000000";
    publisher.closeSession(sessionId);

    try {
      await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
      throw new Error("Expected the cancelled offer to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(WebRtcSignalingError);
      expect((err as WebRtcSignalingError).code).toBe("webrtc_session_cancelled");
    }
    expect(publisher.snapshot()).toMatchObject({ peers: 0, signalingPending: false });
    publisher.close();
  });

  test("uses only host-configured ICE servers for native peers", async () => {
    const peerConfigs: Array<{ iceServers?: string[] }> = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string, config: { iceServers?: string[] }) {
          super(label);
          peerConfigs.push(config);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [{ urls: ["turn:trusted.example:3478"], username: "u", credential: "p" }],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });

    await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId: "00000000-0000-4000-8000-000000000000" });

    expect(peerConfigs[0]?.iceServers).toEqual(["turn:u:p@trusted.example:3478"]);
    publisher.close();
  });

  test("drops until a keyframe after native send backpressure", async () => {
    const connections: FakePeerConnection[] = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string) {
          super(label);
          connections.push(this);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const resetReasons: string[] = [];
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest(reason) {
        resetReasons.push(reason);
      },
    });
    await publisher.handleOffer({
      type: "offer",
      sdp: OFFER_SDP,
      sessionId: "00000000-0000-4000-8000-000000000000",
    });
    connections[0]!.track.sendResults.push(false, true);
    const frame = (isKey: boolean) => ({
      type: "frame" as const,
      data: Buffer.from([isKey ? 1 : 0]),
      pts: 0n,
      isConfig: false,
      isKey,
    });

    const deliveries = [
      publisher.sendFrame(frame(false), null),
      publisher.sendFrame(frame(true), null),
      publisher.sendFrame(frame(false), null),
      publisher.sendFrame(frame(true), null),
    ];
    publisher.resetVideoSource();
    deliveries.push(
      publisher.sendFrame(frame(false), null),
      publisher.sendFrame(frame(true), null),
    );

    expect(deliveries).toEqual([
      { accepted: false, awaitingKeyFrame: true },
      { accepted: false, awaitingKeyFrame: true },
      { accepted: false, awaitingKeyFrame: true },
      { accepted: true, awaitingKeyFrame: false },
      { accepted: false, awaitingKeyFrame: true },
      { accepted: true, awaitingKeyFrame: false },
    ]);
    expect(publisher.snapshot().detail[0]).toMatchObject({
      sessionId: "00000000-0000-4000-8000-000000000000",
      sentFrames: 2,
      droppedFrames: 4,
      awaitingKeyFrame: false,
    });
    expect(resetReasons.filter((reason) => reason === "WebRTC peer backpressure")).toHaveLength(1);
    publisher.close();
  });

  test("keeps aggregate recovery pending when only some peers accept a keyframe", async () => {
    const connections: FakePeerConnection[] = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string) {
          super(label);
          connections.push(this);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    await publisher.handleOffer({
      type: "offer",
      sdp: OFFER_SDP,
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    await publisher.handleOffer({
      type: "offer",
      sdp: OFFER_SDP,
      sessionId: "00000000-0000-4000-8000-000000000002",
    });
    connections[0]!.track.sendResults.push(true);
    connections[1]!.track.sendResults.push(false);

    expect(
      publisher.sendFrame(
        {
          type: "frame",
          data: Buffer.from([1]),
          pts: 0n,
          isConfig: false,
          isKey: true,
        },
        null,
      ),
    ).toEqual({ accepted: true, awaitingKeyFrame: true });
    publisher.close();
  });

  test("reports accepted H.264 payload and selected ICE path inputs for one session", async () => {
    const connections: FakePeerConnection[] = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string) {
          super(label);
          connections.push(this);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    const sessionId = "00000000-0000-4000-8000-000000000000";
    await publisher.handleOffer({ type: "offer", sdp: OFFER_SDP, sessionId });
    const connection = connections[0]!;
    connection.emitState("connected");
    connection.emitIceState("completed");
    connection.selectedCandidatePair = {
      local: {
        address: "192.0.2.1",
        port: 5000,
        type: "host",
        transportType: "udp",
        candidate: "candidate:local",
        mid: "video0",
        priority: 1,
      },
      remote: {
        address: "198.51.100.1",
        port: 6000,
        type: "relay",
        transportType: "tcp",
        candidate: "candidate:remote",
        mid: "video0",
        priority: 2,
      },
    };
    connection.track.sendResults.push(true, true, false);
    const frame = (data: number[], isKey: boolean) => ({
      type: "frame" as const,
      data: Buffer.from(data),
      pts: 0n,
      isConfig: false,
      isKey,
    });

    publisher.sendFrame(frame([1, 2, 3], true), Buffer.from([9, 9]));
    publisher.sendFrame(frame([4, 5], false), null);
    publisher.sendFrame(frame([6], false), null);

    expect(publisher.statsForSession(sessionId)).toEqual({
      sessionId,
      state: "connected",
      iceState: "completed",
      connected: true,
      submittedFrames: 2,
      publisherDroppedFrames: 1,
      payloadBytesSubmitted: 7,
      localCandidateType: "host",
      remoteCandidateType: "relay",
      localCandidateTransport: "udp",
      remoteCandidateTransport: "tcp",
      path: "relay",
    });
    expect(
      publisher.statsForSession("11111111-1111-4111-8111-111111111111"),
    ).toBeNull();

    connection.selectedCandidatePair.local.type = "unknown";
    connection.selectedCandidatePair.remote.type = "host";
    expect(publisher.statsForSession(sessionId)?.path).toBe("unknown");

    connection.selectedCandidatePair.local.type = "srflx";
    expect(publisher.statsForSession(sessionId)?.path).toBe("direct");
    publisher.close();
  });

  test("requires both peer and ICE connectivity and recovers in either event order", async () => {
    const connections: FakePeerConnection[] = [];
    const ndc = {
      ...fakeNodeDataChannel(),
      PeerConnection: class extends FakePeerConnection {
        constructor(label: string) {
          super(label);
          connections.push(this);
        }
      },
    } as unknown as typeof nodeDataChannel;
    const publisher = new WebRtcPublisher(ndc, {
      settings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
      onKeyframeRequest() {},
    });
    await publisher.handleOffer({
      type: "offer",
      sdp: OFFER_SDP,
      sessionId: "00000000-0000-4000-8000-000000000000",
    });
    const connection = connections[0]!;

    connection.emitState("connected");
    expect(publisher.activePeerCount).toBe(0);
    connection.emitIceState("completed");
    expect(publisher.activePeerCount).toBe(1);

    connection.emitState("disconnected");
    expect(publisher.activePeerCount).toBe(0);
    connection.emitIceState("connected");
    expect(publisher.activePeerCount).toBe(0);
    connection.emitState("connected");
    expect(publisher.activePeerCount).toBe(1);

    connection.emitIceState("disconnected");
    expect(publisher.activePeerCount).toBe(0);
    connection.emitState("connected");
    expect(publisher.activePeerCount).toBe(0);
    connection.emitIceState("completed");
    expect(publisher.activePeerCount).toBe(1);
    publisher.close();
  });
});
