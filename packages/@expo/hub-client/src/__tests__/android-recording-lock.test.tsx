import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { DeviceClient } from "../types";
import { useAndroidDeviceClient } from "../useAndroidDevice";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
const realSetInterval = setInterval;
const METADATA_POLL_MS = 1500;

class Socket {
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
}

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});

// A gRPC source that each stream setter can change, so each one sends its own request.
const STREAM_SOURCE = {
  ok: true,
  mode: "grpc-screenshot",
  grpcImageMode: "png",
  encoder: "software",
  availableEncoders: ["software", "hardware"],
  inputSource: "grpc",
  availableInputSources: ["scrcpy", "grpc"],
  availableModes: ["scrcpy", "grpc-screenshot"],
  sessionGeneration: 1,
};
const STREAM_SETTINGS = { maxDimension: 1280, h264Fps: 60, h264Bitrate: 8_000_000 };

/** Each locked control and the one request it sends when the device is not recording. */
const CONTROLS: Array<[string, (client: DeviceClient) => void, string]> = [
  ["rotate", (client) => client.rotate(), 'POST /api/orientation {"orientation":"landscape_left"}'],
  [
    "setOrientation",
    (client) => client.setOrientation("landscape_right"),
    'POST /api/orientation {"orientation":"landscape_right"}',
  ],
  [
    "setStreamSource",
    (client) => client.setStreamSource("scrcpy"),
    'PUT /api/stream-mode {"mode":"scrcpy"}',
  ],
  [
    "setGrpcImageMode",
    (client) => client.setGrpcImageMode("mmap"),
    'PUT /api/stream-mode {"mode":"grpc-screenshot","grpcImageMode":"mmap","inputSource":"grpc"}',
  ],
  [
    "setGrpcEncoder",
    (client) => client.setGrpcEncoder("hardware"),
    'PUT /api/stream-mode {"mode":"grpc-screenshot","grpcImageMode":"png","inputSource":"grpc","encoder":"hardware"}',
  ],
  [
    "setGrpcInputSource",
    (client) => client.setGrpcInputSource("scrcpy"),
    'PUT /api/stream-mode {"mode":"grpc-screenshot","grpcImageMode":"png","inputSource":"scrcpy"}',
  ],
  [
    "updateStreamSettings",
    (client) => client.updateStreamSettings({ h264Fps: 30 }),
    'PATCH /api/stream-settings {"h264Fps":30}',
  ],
];

async function mount(initialRecording: { status: string } | null | "unanswered") {
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
    setTimeout,
    clearTimeout,
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("WebSocket", Socket);
  // `/api` polls run only when the test asks.
  const metadataPolls = new Set<() => void>();
  stubGlobal("setInterval", (callback: () => void, ms?: number) => {
    if (ms === METADATA_POLL_MS) metadataPolls.add(callback);
    return realSetInterval(() => {}, 1_000_000);
  });
  let recording = initialRecording;
  const writes: string[] = [];
  const heldWrites: Array<() => void> = [];
  let holdWrites = false;
  stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push(`${method} ${path} ${init?.body as string}`);
      if (holdWrites) await new Promise<void>((resolve) => heldWrites.push(resolve));
    }
    if (path === "/api") {
      if (recording === "unanswered") return Response.json({}, { status: 503 });
      return Response.json({
        size: { width: 1080, height: 2400 },
        orientation: "portrait",
        ...(recording ? { screenRecording: recording } : {}),
      });
    }
    if (path === "/api/stream-mode") return Response.json(STREAM_SOURCE);
    if (path === "/api/stream-settings") return Response.json(STREAM_SETTINGS);
    if (path === "/api/orientation") {
      const orientation = JSON.parse(init?.body as string).orientation;
      return Response.json({ ok: true, orientation: { pose: orientation } });
    }
    return Response.json({}, { status: 404 });
  });
  let client!: DeviceClient;
  function Harness() {
    client = useAndroidDeviceClient({
      baseUrl: "https://hub.test/",
      device: "emulator-5554",
      enabled: true,
      streamMode: "h264",
    });
    return null;
  }
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await settle();
  return {
    client: () => client,
    writes,
    settle,
    hold: () => (holdWrites = true),
    release: async () => {
      holdWrites = false;
      while (heldWrites.length) heldWrites.shift()!();
      await settle();
    },
    record: async (next: { status: string } | null) => {
      recording = next;
      await act(async () => {
        for (const poll of metadataPolls) poll();
      });
      await settle();
    },
  };
}

async function use(
  harness: Awaited<ReturnType<typeof mount>>,
  control: (client: DeviceClient) => void,
) {
  await act(async () => control(harness.client()));
  await harness.settle();
}

for (const [name, control, request] of CONTROLS) {
  test(`Android ${name} sends ${request.split(" {")[0]} when no recording runs`, async () => {
    const harness = await mount({ status: "complete" });
    expect(harness.client().recordingControlsLocked).toBe(false);
    await use(harness, control);
    expect(harness.writes).toEqual([request]);
  });

  test.each(["waiting", "recording", "finalizing"])(
    `Android ignores ${name} while a recording is %s`,
    async (status) => {
      const harness = await mount({ status });
      expect(harness.client().recordingControlsLocked).toBe(true);
      await use(harness, control);
      expect(harness.writes).toEqual([]);
    },
  );
}

test("Android locks the controls until the first recording status arrives", async () => {
  const harness = await mount("unanswered");
  expect(harness.client().screenRecording).toBe("unknown");
  expect(harness.client().recordingControlsLocked).toBe(true);
  for (const [, control] of CONTROLS) await use(harness, control);
  expect(harness.writes).toEqual([]);
});

test.each([[{ status: "failed" }], [null]])(
  "Android unlocks the controls when the recording status is %p",
  async (recording) => {
    const harness = await mount(recording);
    expect(harness.client().recordingControlsLocked).toBe(false);
    await use(harness, (client) => client.setOrientation("landscape_left"));
    expect(harness.writes).toEqual(['POST /api/orientation {"orientation":"landscape_left"}']);
  },
);

test("Android follows a recording that starts and stops while it is mounted", async () => {
  const harness = await mount(null);
  const turn = (client: DeviceClient) => client.setOrientation("portrait_upside_down");
  expect(harness.client().recordingControlsLocked).toBe(false);

  await harness.record({ status: "recording" });
  expect(harness.client().recordingControlsLocked).toBe(true);
  await use(harness, turn);
  expect(harness.writes).toEqual([]);

  await harness.record({ status: "complete" });
  expect(harness.client().recordingControlsLocked).toBe(false);
  await use(harness, turn);
  expect(harness.writes).toEqual(['POST /api/orientation {"orientation":"portrait_upside_down"}']);

  await harness.record({ status: "waiting" });
  expect(harness.client().recordingControlsLocked).toBe(true);
});

test("Android drops a queued orientation when a recording starts before it goes out", async () => {
  const harness = await mount(null);
  harness.hold();
  await use(harness, (client) => client.setOrientation("landscape_left"));
  await use(harness, (client) => client.setOrientation("landscape_right"));
  await harness.record({ status: "waiting" });
  await harness.release();
  expect(harness.writes).toEqual(['POST /api/orientation {"orientation":"landscape_left"}']);
  expect(harness.client().orientationError).toContain("screen recording started");
});
