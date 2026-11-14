import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { DeviceSessionState } from "../src/device-session-state.ts";
import { createApp, type AppClock, type CreateAppDependencies } from "../src/middleware.ts";
import { ScreenRecording } from "../src/screen-recording.ts";
import { type ScrcpySession, type VideoFrame, type VideoPacket } from "../src/scrcpy.ts";
import {
  adaptScrcpySession,
  type EmuSession,
  type ExperimentalGpuCaptureDiagnostics,
  type GrpcCaptureDiagnostics,
  type StartEmuSessionOptions,
} from "../src/stream-session.ts";
import type { WebRtcPublisher, WebRtcPublisherSessionStats } from "../src/webrtc-publisher.ts";
import { readNoOrientation, watchNoOrientationEvents } from "./fixtures/orientation.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000000";

const GRPC_CAPTURE_DIAGNOSTICS: GrpcCaptureDiagnostics = {
  encoderName: "libx264",
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
    statsForSession: (sessionId: string) => (sessionId === SESSION_ID ? stats : null),
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
      readOrientation: readNoOrientation,
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
    const response = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await response.json()).toMatchObject({
      screenRecording: null,
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
      readOrientation: readNoOrientation,
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
      readOrientation: readNoOrientation,
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

    const healthResponse = await app.handleRequest(new Request("http://middleware.test/health"));
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
      readOrientation: readNoOrientation,
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );

  try {
    await openWebRtcViewer(app);
    await drained;
    const response = await app.handleRequest(
      new Request(`http://middleware.test/webrtc/stats?sessionId=${SESSION_ID}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: SESSION_ID })],
    });
  } finally {
    await app.stop();
  }
});

// As serve-sim's `--transport webrtc` refuses its HTTP streams.
test("with a WebRTC transport, refuses WebSocket video and keeps WebSocket input", async () => {
  const clock = new ManualAppClock();
  const { session } = fakeScrcpySession(1);
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
      readOrientation: readNoOrientation,
      startSession: async () => adaptScrcpySession(session),
      createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      clock,
    },
  );
  const attach = (video: boolean) => {
    const closed: Array<[number | undefined, string | undefined]> = [];
    app.attachWebSocket(
      {
        bufferedAmount: 0,
        send: () => {},
        close: (code, reason) => void closed.push([code, reason]),
        onMessage: () => {},
        onClose: () => {},
      },
      { frameMeta: false, video },
    );
    return closed;
  };

  try {
    expect(attach(true)).toEqual([[1008, "stream_transport_locked"]]);
    expect(attach(false)).toEqual([]);
    const api = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await api.json()).toMatchObject({
      viewerTransports: { default: "webrtc", available: ["webrtc"] },
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
      readOrientation: readNoOrientation,
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
      readOrientation: readNoOrientation,
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

test("reports GPU capture health from one diagnostics snapshot", async () => {
  const diagnostics: ExperimentalGpuCaptureDiagnostics = {
    backend: "expo-emulator-capture",
    framePath: "gpu",
    hardwareEncoder: true,
    encoderName: "com.apple.videotoolbox.videoencoder.h264.rtvc",
    packets: 120,
    bytes: 1_000_000,
    requestedKeyFrames: 2,
    queuedBytes: 0,
    fps: 60,
    nativeSize: { width: 1080, height: 2424 },
    streamSize: { width: 570, height: 1280 },
    maxSize: 1280,
    resizes: 0,
  };
  let samples = 0;
  const { session } = fakeScrcpySession(0);
  const app = await createApp(
    { serial: session.serial },
    {
      startSession: async () => ({
        ...adaptScrcpySession(session),
        diagnostics: () => {
          samples++;
          return { experimentalGpuCapture: diagnostics };
        },
      }),
    },
  );
  try {
    const before = samples;
    expect(app.health()).toMatchObject({
      streamMode: "scrcpy",
      captureBackend: "expo-emulator-capture",
      experimentalGpuCapture: diagnostics,
      encoderName: "com.apple.videotoolbox.videoencoder.h264.rtvc",
    });
    expect(samples - before).toBe(1);
  } finally {
    await app.stop();
  }
});

test("gives every emulator capture it starts the agent socket and a rotation reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "create-app-capture-"));
  const agentListener = Bun.listen({
    unix: join(directory, "emulator-5554.sock"),
    socket: { data() {} },
  });
  const requests: StartEmuSessionOptions[] = [];
  const app = await createApp(
    {
      serial: "emulator-5554",
      streamMode: "emulator-capture",
      emulatorCapture: { socketDirectory: directory },
    },
    {
      startSession: async (options) => {
        requests.push(options);
        // A capture session reports its own mode, as startGpuCaptureSession does.
        return { ...adaptScrcpySession(fakeScrcpySession(0).session), mode: options.mode };
      },
      readDisplayRotation: async () => 1,
    },
  );
  try {
    const response = await app.handleRequest(
      new Request("http://localhost/api/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h264Fps: 60 }),
      }),
    );
    expect(response.status).toBe(200);
    expect(requests.map((request) => [request.mode, request.inputSource])).toEqual([
      ["emulator-capture", "scrcpy"],
      ["emulator-capture", "scrcpy"],
    ]);
    expect(requests.map((request) => request.emulatorCaptureSocket)).toEqual([
      join(directory, "emulator-5554.sock"),
      join(directory, "emulator-5554.sock"),
    ]);
    expect(await requests[0]!.readDisplayRotation?.(new AbortController().signal)).toBe(1);
  } finally {
    agentListener.stop(true);
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("asks a source that follows the display to read it again after a rotation", async () => {
  let displayChanges = 0;
  const app = await createApp(
    { serial: "emulator-5554" },
    {
      startSession: async () => ({
        ...adaptScrcpySession(fakeScrcpySession(0).session),
        displayChanged: () => {
          displayChanges++;
        },
      }),
      readOrientation: readNoOrientation,
      applyRotation: async () => ({
        mode: "lock",
        rotation: 1,
        orientation: "landscape",
        pose: null,
        raw: "accelerometer_rotation=0 user_rotation=1",
      }),
    },
  );
  try {
    const response = await app.handleRequest(
      new Request("http://localhost/api/orientation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation: "landscape" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(displayChanges).toBe(1);
  } finally {
    await app.stop();
  }
});

test.each(["mmap", "rgb888"] as const)(
  "includes %s session capture diagnostics in WebRTC stats",
  async (imageMode) => {
    const diagnostics = { ...GRPC_CAPTURE_DIAGNOSTICS, imageMode };
    const { session, drained } = fakeScrcpySession(1);
    const adapted = adaptScrcpySession(session);
    const grpcSession: EmuSession = {
      ...adapted,
      mode: "grpc-screenshot",
      diagnostics: () => ({ grpcCapture: diagnostics }),
    };
    const app = await createApp(
      {
        serial: session.serial,
        streamMode: "grpc-screenshot",
        grpcImageMode: imageMode,
        streamSettings: {
          transport: "webrtc",
          codec: "h264",
          iceServers: [],
          iceTransportPolicy: "all",
        },
      },
      {
        readOrientation: readNoOrientation,
        startSession: async () => grpcSession,
        createWebRtcPublisher: async () => fakeWebRtcPublisher(),
      },
    );

    try {
      await openWebRtcViewer(app);
      await drained;
      expect(app.health()).toMatchObject({
        streamMode: "grpc-screenshot",
        grpcImageMode: imageMode,
        grpcCapture: diagnostics,
      });
      expect(app.webRtcStats(SESSION_ID)).toMatchObject({
        capture: { grpc: diagnostics },
      });
    } finally {
      await app.stop();
    }
  },
);

test("keeps the screen recording active when the capture ends and the app stops", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-app-screen-recording-"));
  const keyframe = Buffer.from(
    "000000016742c01fd9005005bb0110000003001000000303c0f18324800000000168cb83cb200000000165888421",
    "hex",
  );
  const timestamps: number[] = [];
  const recorder = await ScreenRecording.create({
    directory: join(root, "session"),
    udid: "device-test",
    deviceName: "Pixel",
    runtimeDisplayName: "Android 16",
    createWriter: async ({ path }) => {
      await writeFile(path, "test-writer");
      return {
        add: async (sample) => {
          timestamps.push(sample.timestamp);
        },
        finish: async () => {},
        cancel: async () => {},
      };
    },
  });
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): boolean;
  };
  controlSocket.write = () => true;
  let endStream!: () => void;
  const end = new Promise<null>((resolve) => {
    endStream = () => resolve(null);
  });
  let sent = false;
  const session = {
    transport: "scrcpy",
    meta: { deviceName: "recording-test", codecId: "h264", width: 720, height: 1_280 },
    protocol: 3,
    videoReader: {},
    controlSocket,
    proc: new EventEmitter(),
    scid: "00000001",
    localPort: 27_200,
    serial: "device-test",
    readFrame: (): Promise<VideoFrame | null> => {
      if (sent) return end;
      sent = true;
      return Promise.resolve({
        type: "frame",
        data: keyframe,
        pts: 0n,
        isConfig: false,
        isKey: true,
      });
    },
    close: () => endStream(),
  } as unknown as ScrcpySession;
  const app = await createApp(
    { serial: session.serial, screenRecording: recorder },
    { readOrientation: readNoOrientation, startSession: async () => adaptScrcpySession(session) },
  );
  try {
    await recorder.ready;
    const recordingInfo = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await recordingInfo.json()).toMatchObject({ screenRecording: { status: "recording" } });
    endStream();
    for (let i = 0; i < 200 && app.health().status !== "error"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(app.health().status).toBe("error");
    expect(recorder.active).toBe(true);
    await app.stop();
    expect(recorder.active).toBe(true);
    // The replacement capture resumes 5 s later with the same SPS/PPS.
    recorder.accept(
      { type: "frame", data: keyframe, pts: 5_000_000n, isConfig: false, isKey: true },
      { width: 720, height: 1_280 },
      "scrcpy",
    );
    await recorder.finish();
    const completedInfo = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await completedInfo.json()).toMatchObject({ screenRecording: { status: "complete" } });
    expect(timestamps).toEqual([0, 5]);
    const manifest = JSON.parse(await readFile(join(root, "session", "session.json"), "utf8"));
    expect(manifest.status).toBe("complete");
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function pushableScrcpySession(): {
  session: ScrcpySession;
  push: (frame: VideoPacket | null) => void;
} {
  const queue: (VideoPacket | null)[] = [];
  let waiting: ((frame: VideoPacket | null) => void) | null = null;
  const controlSocket = new EventEmitter() as EventEmitter & {
    write(data: Uint8Array): boolean;
  };
  controlSocket.write = () => true;
  const session = {
    transport: "scrcpy",
    meta: { deviceName: "session-test", codecId: "h264", width: 720, height: 1_280 },
    protocol: 4,
    videoReader: {},
    controlSocket,
    proc: new EventEmitter(),
    scid: "00000002",
    localPort: 27_201,
    serial: "device-test",
    readFrame: (): Promise<VideoPacket | null> => {
      const next = queue.shift();
      if (next !== undefined) return Promise.resolve(next);
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close: () => {},
  } as unknown as ScrcpySession;
  return {
    session,
    push: (frame) => {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(frame);
      } else {
        queue.push(frame);
      }
    },
  };
}

test("only announces video-session when the scrcpy session size changes", async () => {
  const { session, push } = pushableScrcpySession();
  const app = await createApp(
    { serial: session.serial },
    { readOrientation: readNoOrientation, startScrcpy: async () => session },
  );
  const sent: (string | Uint8Array)[] = [];
  app.attachWebSocket(
    {
      bufferedAmount: 0,
      send: (data) => void sent.push(data),
      close: () => {},
      onMessage: () => {},
      onClose: () => {},
    },
    { frameMeta: false },
  );
  const announced = () =>
    sent
      .filter((message): message is string => typeof message === "string")
      .map((message) => JSON.parse(message))
      .filter((message) => message.type === "video-session")
      .map((message) => message.size);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  try {
    expect(announced()).toEqual([]);

    push({ type: "session", width: 720, height: 1_280, clientResized: false });
    await settle();
    expect(announced()).toEqual([]);

    push({ type: "session", width: 540, height: 1_000, clientResized: false });
    await settle();
    expect(announced()).toEqual([{ width: 540, height: 1_000 }]);
  } finally {
    push(null);
    await app.stop();
  }
});

test("reports the display orientation in /api and /health and records the locked pose", async () => {
  const { session } = fakeScrcpySession(0);
  const calls: string[] = [];
  const deviceState = new DeviceSessionState({
    serial: session.serial,
    applyLocation: async () => {},
    readOrientation: async (serial) => (calls.push(`read ${serial}`), "portrait"),
    applyRotation: async (serial, orientation) => {
      calls.push(`lock ${serial} ${orientation}`);
      return {
        mode: "lock",
        rotation: 3,
        orientation: "landscape",
        pose: "landscape_left",
        raw: "lock 3",
      };
    },
  });
  const app = await createApp(
    { serial: session.serial, deviceState },
    { startSession: async () => adaptScrcpySession(session) },
  );

  try {
    const info = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await info.json()).toMatchObject({ pose: "portrait" });
    const health = await app.handleRequest(new Request("http://middleware.test/health"));
    expect(await health.json()).toMatchObject({ pose: "portrait" });

    const locked = await app.handleRequest(
      new Request("http://middleware.test/api/orientation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation: "landscape_left" }),
      }),
    );
    expect(await locked.json()).toMatchObject({
      ok: true,
      orientation: { pose: "landscape_left" },
    });
    // `/api` right after the lock reports the locked pose without another read.
    const after = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await after.json()).toMatchObject({ pose: "landscape_left" });
    expect(calls).toEqual([`read ${session.serial}`, `lock ${session.serial} landscape_left`]);
  } finally {
    app.stop();
  }
});

const FOLD_DISPLAYS = {
  inner: { width: 2076, height: 2152 },
  outer: { width: 1080, height: 2424 },
};
const FOLD_KEYFRAME = Buffer.from(
  "000000016742c01fd9005005bb0110000003001000000303c0f18324800000000168cb83cb200000000165888421",
  "hex",
);

async function foldRecorder(root: string) {
  return ScreenRecording.create({
    directory: join(root, "session"),
    udid: "device-test",
    deviceName: "Pixel_9_Pro_Fold",
    runtimeDisplayName: "Android 16",
    createWriter: async ({ path }) => {
      await writeFile(path, "test-writer");
      return { add: async () => {}, finish: async () => {}, cancel: async () => {} };
    },
  });
}

test("a foldable's gRPC capture records on the fold canvas and reports that it follows folds", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-app-fold-recording-"));
  const recorder = await foldRecorder(root);
  const { session } = fakeScrcpySession(1);
  let recording: Parameters<NonNullable<CreateAppDependencies["startSession"]>>[0]["recording"];
  let sensorOpened = false;
  let sensorClosed = false;
  const app = await createApp(
    {
      serial: session.serial,
      streamMode: "grpc-screenshot",
      maxSize: 960,
      screenRecording: recorder,
    },
    {
      readOrientation: async () => "landscape_left",
      readShownOrientation: async () => ({ orientation: "landscape_left", settling: false }),
      watchOrientationEvents: watchNoOrientationEvents,
      readFoldableDisplays: async () => FOLD_DISPLAYS,
      readFoldState: async () => ({ supported: true, posture: "opened", hingeAngle: 180 }),
      openHingeSensor: async () => {
        sensorOpened = true;
        return {
          readAngle: async () => 180,
          watchPostures: (_onChange, signal) =>
            new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
          close: () => {
            sensorClosed = true;
          },
        };
      },
      startSession: async (options) => {
        recording = options.recording;
        return { ...adaptScrcpySession(session), mode: "grpc-screenshot", feedsRecording: true };
      },
    },
  );
  try {
    expect(recording?.canvas).toEqual({ width: 926, height: 960 });
    expect(recorder.followsFold).toBe(true);
    // The recording reads the hinge over gRPC while it follows folds.
    expect(sensorOpened).toBe(true);
    // A fold canvas frame's PTS is the host monotonic time of its capture.
    const pts = BigInt(Math.round(performance.now() * 1000));
    recording!.accept(
      { type: "frame", data: FOLD_KEYFRAME, pts, isConfig: false, isKey: true },
      {
        width: 2076,
        height: 2152,
        screen: "inner",
        contentRect: { x: 0, y: 0, width: 926, height: 960 },
      },
    );
    await recorder.ready;
    const info = await app.handleRequest(new Request("http://middleware.test/api"));
    expect(await info.json()).toMatchObject({
      screenRecording: { status: "recording", followsFold: true },
    });
    await recorder.finish();
    const manifest = JSON.parse(await readFile(join(root, "session", "session.json"), "utf8"));
    expect(manifest).toMatchObject({ width: 926, height: 960 });
    expect(manifest.deviceStates).toEqual([
      {
        timeMs: 0,
        state: {
          width: 2076,
          height: 2152,
          screen: "inner",
          contentRect: { x: 0, y: 0, width: 926, height: 960 },
          hingeAngle: 180,
          orientation: "landscape_left",
        },
      },
    ]);
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
  expect(sensorClosed).toBe(true);
});

test("a fold recording names the pose that the display shows after a Hub rotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-app-fold-rotation-"));
  const recorder = await foldRecorder(root);
  const { session } = fakeScrcpySession(1);
  let recording: Parameters<NonNullable<CreateAppDependencies["startSession"]>>[0]["recording"];
  // The top app keeps portrait under a landscape lock, as the launcher does.
  let shown: "portrait" | "landscape_left" = "portrait";
  const deviceState = new DeviceSessionState({
    serial: session.serial,
    applyLocation: async () => {},
    readOrientation: async () => shown,
    applyRotation: async () => ({
      mode: "lock",
      rotation: 3,
      orientation: "landscape",
      pose: "landscape_left",
      raw: "lock 3",
    }),
  });
  const app = await createApp(
    {
      serial: session.serial,
      streamMode: "grpc-screenshot",
      maxSize: 960,
      screenRecording: recorder,
      deviceState,
    },
    {
      readOrientation: async () => shown,
      readShownOrientation: async () => ({ orientation: shown, settling: false }),
      watchOrientationEvents: watchNoOrientationEvents,
      readFoldableDisplays: async () => FOLD_DISPLAYS,
      readFoldState: async () => ({ supported: true, posture: "opened", hingeAngle: 180 }),
      openHingeSensor: async () => ({
        readAngle: async () => 180,
        watchPostures: (_onChange, signal) =>
          new Promise((resolve) => signal.addEventListener("abort", () => resolve())),
        close: () => {},
      }),
      startSession: async (options) => {
        recording = options.recording;
        return { ...adaptScrcpySession(session), mode: "grpc-screenshot", feedsRecording: true };
      },
    },
  );
  const frame = () => {
    const pts = BigInt(Math.round(performance.now() * 1000));
    recording!.accept(
      { type: "frame", data: FOLD_KEYFRAME, pts, isConfig: false, isKey: true },
      {
        width: 2076,
        height: 2152,
        screen: "inner",
        contentRect: { x: 0, y: 0, width: 926, height: 960 },
      },
    );
  };
  const rotate = () =>
    app.handleRequest(
      new Request("http://middleware.test/api/orientation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orientation: "landscape" }),
      }),
    );
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    frame();
    await recorder.ready;
    expect((await rotate()).status).toBe(200);
    // Longer than the 100 ms hinge read, which took the requested pose before this fix.
    await new Promise((resolve) => setTimeout(resolve, 150));
    frame();
    await recorder.finish();
    const manifest = JSON.parse(await readFile(join(root, "session", "session.json"), "utf8"));
    expect(
      manifest.deviceStates.map(
        (entry: { state: { orientation?: string } }) => entry.state.orientation,
      ),
    ).toEqual(["portrait"]);
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses a fold while the recording takes the viewers' packets", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-app-fold-locked-"));
  const recorder = await foldRecorder(root);
  const { session } = fakeScrcpySession(1);
  let requestedRecording = false;
  const app = await createApp(
    { serial: session.serial, screenRecording: recorder },
    {
      readOrientation: readNoOrientation,
      readFoldableDisplays: async () => FOLD_DISPLAYS,
      startSession: async (options) => {
        requestedRecording = options.recording !== undefined;
        return adaptScrcpySession(session);
      },
    },
  );
  try {
    // scrcpy capture never encodes the fold canvas.
    expect(requestedRecording).toBe(false);
    expect(recorder.followsFold).toBe(false);
    const response = await app.handleRequest(
      new Request("http://middleware.test/api/fold", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture: "closed" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false });
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a native-size MMAP fold recording sizes its canvas from the shown display", async () => {
  const root = await mkdtemp(join(tmpdir(), "create-app-fold-mmap-"));
  const recorder = await foldRecorder(root);
  const { session } = fakeScrcpySession(1);
  let canvas: { width: number; height: number } | undefined;
  // Rear display mode: the hinge says open, but the outer display is shown.
  const app = await createApp(
    {
      serial: session.serial,
      streamMode: "grpc-screenshot",
      grpcImageMode: "mmap",
      maxSize: 0,
      screenRecording: recorder,
    },
    {
      readOrientation: readNoOrientation,
      readShownOrientation: readNoOrientation,
      watchOrientationEvents: watchNoOrientationEvents,
      readFoldableDisplays: async () => FOLD_DISPLAYS,
      readFoldState: async () => ({ supported: true, posture: "opened", hingeAngle: 180 }),
      readDisplaySize: async () => ({ width: 1080, height: 2424 }),
      startSession: async (options) => {
        canvas = options.recording?.canvas;
        return { ...adaptScrcpySession(session), mode: "grpc-screenshot", feedsRecording: true };
      },
    },
  );
  try {
    expect(canvas).toEqual({ width: 2076, height: 2424 });
  } finally {
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
});
