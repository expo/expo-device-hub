import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import {
  createApp,
  type AppClock,
} from "../src/middleware.ts";
import {
  type ScrcpySession,
  type VideoFrame,
} from "../src/scrcpy.ts";
import {
  adaptScrcpySession,
  type EmuSession,
  type GrpcCaptureDiagnostics,
} from "../src/stream-session.ts";
import type {
  WebRtcPublisher,
  WebRtcPublisherSessionStats,
} from "../src/webrtc-publisher.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const GRPC_CAPTURE_DIAGNOSTICS: GrpcCaptureDiagnostics = {
  imageMode: "mmap",
  rawGrpcMessagesReceived: 120,
  rawGrpcMessagesEmitted: 100,
  rawGrpcMessagesCoalesced: 20,
  usableImages: 98,
  sourceTimestampFps: 59.9,
  rawMessageReceiveFps: 60,
  usableImageFps: 58.8,
  freshEncoderWriteFps: 58.2,
  sequenceGaps: 22,
  imagePayloadBytes: 2_211_840,
  transportBytes: 216_760_320,
  grpcMessageBytesReceived: 4_800,
  mmapFileBytesRead: 433_520_640,
  mmapReadRetries: 0,
  mmapTornFramesDropped: 0,
  sourceTimestampIntervalMs: {
    windowSamples: 97,
    latest: 16.7,
    p50: 16.6,
    p95: 20.1,
    max: 25,
  },
  rawMessageReceiveIntervalMs: {
    windowSamples: 119,
    latest: 16.6,
    p50: 16.6,
    p95: 18,
    max: 22,
  },
  productionToReceiveLatencyMs: {
    windowSamples: 98,
    latest: 4.2,
    p50: 3.8,
    p95: 8.5,
    max: 12,
  },
  productionToUsableLatencyMs: {
    windowSamples: 98,
    latest: 5.2,
    p50: 4.8,
    p95: 9.5,
    max: 13,
  },
  protobufDecodeTimeMs: {
    windowSamples: 100,
    latest: 0.1,
    p50: 0.1,
    p95: 0.2,
    max: 0.3,
  },
  sharedReadCopyTimeMs: {
    windowSamples: 98,
    latest: 1,
    p50: 0.9,
    p95: 1.4,
    max: 2.5,
  },
  freshEncoderWriteAttempts: 96,
  repeatEncoderWriteAttempts: 2,
  acceptedEncoderWrites: 95,
  encoderBackpressureRejections: 3,
};

class ManualAppClock implements AppClock {
  #nowMs = 0;
  #callback: (() => void) | null = null;
  readonly #timer = Symbol("middleware interval");

  now(): number {
    return this.#nowMs;
  }

  setInterval(callback: () => void, intervalMs: number): unknown {
    expect(intervalMs).toBe(1_000);
    expect(this.#callback).toBeNull();
    this.#callback = callback;
    return this.#timer;
  }

  clearInterval(timer: unknown): void {
    expect(timer).toBe(this.#timer);
    this.#callback = null;
  }

  advance(elapsedMs: number): void {
    this.#nowMs += elapsedMs;
  }

  sampleAfter(elapsedMs: number): void {
    this.advance(elapsedMs);
    this.#callback?.();
  }
}

function fakeScrcpySession(
  frameTotal: number,
  beforeFrame?: () => void,
): {
  session: ScrcpySession;
  drained: Promise<void>;
} {
  const proc = new EventEmitter();
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): boolean;
  };
  controlSocket.write = () => true;

  let remainingFrames = frameTotal;
  let nextPts = 0n;
  let resolveDrained!: () => void;
  let resolveEnd!: (frame: null) => void;
  let reportedDrained = false;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  const end = new Promise<null>((resolve) => {
    resolveEnd = resolve;
  });

  const session = {
    transport: "scrcpy",
    meta: {
      deviceName: "middleware-fps-test",
      codecId: "h264",
      width: 720,
      height: 1_280,
    },
    protocol: 3,
    videoReader: {},
    controlSocket,
    proc,
    scid: "00000001",
    localPort: 27_200,
    serial: "device-test",
    readFrame: (): Promise<VideoFrame | null> => {
      if (remainingFrames > 0) {
        remainingFrames--;
        beforeFrame?.();
        const frame: VideoFrame = {
          type: "frame",
          data: Buffer.from([0, 0, 0, 1, 1]),
          pts: nextPts++,
          isConfig: false,
          isKey: false,
        };
        return Promise.resolve(frame);
      }
      if (!reportedDrained) {
        reportedDrained = true;
        resolveDrained();
      }
      return end;
    },
    close: () => {
      resolveEnd(null);
    },
  } as unknown as ScrcpySession;

  return { session, drained };
}

function fakeWebRtcPublisher(): WebRtcPublisher {
  const stats: WebRtcPublisherSessionStats = {
    sessionId: SESSION_ID,
    state: "connected",
    iceState: "connected",
    connected: true,
    submittedFrames: 50,
    publisherDroppedFrames: 0,
    payloadBytesSubmitted: 250,
    localCandidateType: "host",
    remoteCandidateType: "host",
    localCandidateTransport: "udp",
    remoteCandidateTransport: "udp",
    path: "direct",
  };
  return {
    activePeerCount: 1,
    handleOffer: async () => ({ type: "answer", sdp: "v=0\r\n" }),
    closeSession: () => {},
    statsForSession: (sessionId: string) =>
      sessionId === SESSION_ID ? stats : null,
    sendFrame: () => ({ accepted: true, awaitingKeyFrame: false }),
    snapshot: () => ({
      peers: 1,
      activePeers: 1,
      signalingPending: false,
      detail: [],
    }),
    resetVideoSource: () => {},
    close: () => {},
  } as unknown as WebRtcPublisher;
}

async function openWebRtcViewer(app: {
  handleRequest(request: Request): Promise<Response>;
}): Promise<void> {
  const response = await app.handleRequest(
    new Request("http://middleware.test/webrtc/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "offer",
        sdp: "v=0\r\n",
        sessionId: SESSION_ID,
        codec: "h264",
      }),
    }),
  );
  expect(response.status).toBe(200);
}

test("advertises viewer transports and lazily creates WebRTC for a websocket default", async () => {
  const { session } = fakeScrcpySession(0);
  let createCalls = 0;
  let publisherSettings: unknown;
  const app = await createApp(
    { serial: session.serial },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async (options) => {
        createCalls++;
        publisherSettings = options.settings;
        return fakeWebRtcPublisher();
      },
    },
  );

  try {
    expect(createCalls).toBe(0);
    const response = await app.handleRequest(
      new Request("http://middleware.test/api"),
    );
    expect(await response.json()).toMatchObject({
      stream: { transport: "websocket" },
      viewerTransports: {
        default: "websocket",
        available: ["websocket", "webrtc"],
        webrtc: {
          transport: "webrtc",
          codec: "h264",
          iceTransportPolicy: "all",
          iceServers: [
            { urls: ["stun:stun.l.google.com:19302"] },
            { urls: ["stun:stun1.l.google.com:19302"] },
          ],
        },
      },
    });
    expect(createCalls).toBe(0);

    await openWebRtcViewer(app);
    expect(createCalls).toBe(1);
    expect(publisherSettings).toMatchObject({
      transport: "webrtc",
      codec: "h264",
      iceTransportPolicy: "all",
    });
  } finally {
    await app.stop();
  }
});

test("a close racing lazy middleware publisher startup cancels the pending viewer", async () => {
  const { session } = fakeScrcpySession(0);
  const publisher = fakeWebRtcPublisher();
  const closedSessionIds: string[] = [];
  publisher.closeSession = (sessionId) => {
    closedSessionIds.push(sessionId);
  };
  let notifyFactoryStarted!: () => void;
  const factoryStarted = new Promise<void>((resolve) => {
    notifyFactoryStarted = resolve;
  });
  let releasePublisher!: (publisher: WebRtcPublisher) => void;
  const publisherReady = new Promise<WebRtcPublisher>((resolve) => {
    releasePublisher = resolve;
  });
  const app = await createApp(
    { serial: session.serial },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => {
        notifyFactoryStarted();
        return publisherReady;
      },
    },
  );

  try {
    const offer = app.handleRequest(
      new Request("http://middleware.test/webrtc/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "offer",
          sdp: "v=0\r\n",
          sessionId: SESSION_ID,
          codec: "h264",
        }),
      }),
    );
    await factoryStarted;
    const close = app.handleRequest(
      new Request("http://middleware.test/webrtc/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID }),
      }),
    );

    releasePublisher(publisher);
    expect((await offer).status).toBe(200);
    expect((await close).status).toBe(204);
    expect(closedSessionIds).toEqual([SESSION_ID]);
  } finally {
    releasePublisher(publisher);
    await app.stop();
  }
});

test("normalizes middleware source FPS by the actual elapsed time", async () => {
  const clock = new ManualAppClock();
  const { session, drained } = fakeScrcpySession(50);
  const app = await createApp(
    {
      serial: session.serial,
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await openWebRtcViewer(app);
    await drained;
    expect(app.health().frames).toBe(50);

    clock.sampleAfter(0);
    clock.sampleAfter(2_500);

    const healthResponse = await app.handleRequest(
      new Request("http://middleware.test/health"),
    );
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toMatchObject({
      frames: 50,
      sourceFps: 20,
    });
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      source: { frames: 50, fps: 20 },
    });
  } finally {
    app.stop();
  }
});

test("serves viewer-scoped WebRTC statistics from createApp.handleRequest", async () => {
  const clock = new ManualAppClock();
  const { session, drained } = fakeScrcpySession(1);
  const app = await createApp(
    {
      serial: session.serial,
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await openWebRtcViewer(app);
    await drained;
    const response = await app.handleRequest(
      new Request(
        `http://middleware.test/webrtc/stats?sessionId=${SESSION_ID}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: SESSION_ID })],
    });
  } finally {
    await app.stop();
  }
});

test("uses the 30 FPS middleware default when maxFps is omitted", async () => {
  const { session } = fakeScrcpySession(0);
  let openedMaxFps: number | undefined;
  const app = await createApp(
    { serial: session.serial },
    {
      startSession: async (options) => {
        openedMaxFps = options.maxFps;
        return adaptScrcpySession(session);
      },
    },
  );

  try {
    expect(openedMaxFps).toBe(30);
  } finally {
    await app.stop();
  }
});

test("reports configured source settings and rolling encoded-frame timing", async () => {
  const clock = new ManualAppClock();
  const { session, drained } = fakeScrcpySession(3, () => clock.advance(20));
  const app = await createApp(
    {
      serial: session.serial,
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await openWebRtcViewer(app);
    await drained;
    const frameStats = {
      windowFrames: 3,
      intervalMs: { p50: 20, p95: 20, max: 20 },
      avgKeyFrameBytes: null,
      avgDeltaFrameBytes: 5,
      keyFramesInWindow: 0,
    };
    expect(app.health()).toMatchObject({ frameStats });
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      source: {
        streamMode: "scrcpy",
        configuredFps: 30,
        frameStats,
      },
    });
  } finally {
    await app.stop();
  }
});

test("includes optional gRPC session capture diagnostics in WebRTC stats", async () => {
  const { session, drained } = fakeScrcpySession(1);
  const adapted = adaptScrcpySession(session);
  const grpcSession: EmuSession = {
    ...adapted,
    mode: "grpc-screenshot",
    diagnostics: () => ({ grpcCapture: GRPC_CAPTURE_DIAGNOSTICS }),
  };
  const app = await createApp(
    {
      serial: session.serial,
      streamMode: "grpc-screenshot",
      grpcImageMode: "mmap",
      streamSettings: {
        transport: "webrtc",
        codec: "h264",
        iceServers: [],
        iceTransportPolicy: "all",
      },
    },
    {
      startSession: async () => grpcSession,
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
    },
  );

  try {
    await openWebRtcViewer(app);
    await drained;
    expect(app.health()).toMatchObject({
      streamMode: "grpc-screenshot",
      grpcImageMode: "mmap",
      grpcCapture: GRPC_CAPTURE_DIAGNOSTICS,
    });
    expect(app.webRtcStats(SESSION_ID)).toMatchObject({
      capture: { grpc: GRPC_CAPTURE_DIAGNOSTICS },
    });
  } finally {
    await app.stop();
  }
});
