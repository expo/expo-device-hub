import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureRecordingCanvas,
  captureRecordingEncoding,
  displayRefreshRate,
  startCaptureRecordingSource,
  type CaptureRecordingSourceOptions,
} from "../src/capture-recording-source.ts";
import type { FoldableDisplays } from "../src/fold.ts";
import { GPU_RECORD } from "../src/gpu-packet.ts";
import { GpuCaptureEncoderError, GpuCaptureUnavailableError } from "../src/gpu-session.ts";
import { ScreenRecording } from "../src/screen-recording.ts";

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x20]);
const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
const delta = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x10]);
const keyFrame = Buffer.concat([sps, pps, idr]);

const PIXEL_9_PRO_FOLD: FoldableDisplays = {
  inner: { width: 2076, height: 2152 },
  outer: { width: 1080, height: 2424 },
  closedHinge: { min: 0, max: 30 },
};

function record(
  flags: number,
  data: Buffer,
  pts: bigint,
  width: number,
  height: number,
  fps = 60,
): Buffer {
  const header = Buffer.alloc(32);
  header.write("GPC1");
  header.writeUInt32BE(data.length, 4);
  header.writeBigUInt64BE(pts, 8);
  header.writeUInt32BE(flags, 16);
  header.writeUInt32BE(width, 20);
  header.writeUInt32BE(height, 24);
  header.writeUInt32BE(fps, 28);
  return Buffer.concat([header, data]);
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const hello = (details: Record<string, unknown>, width = 1080, height = 2424) =>
  record(GPU_RECORD.hello, json(details), 0n, width, height);
const configured = (
  canvas: { width: number; height: number },
  contentRect: { x: number; y: number; width: number; height: number },
  fromPts: number,
) =>
  record(
    GPU_RECORD.configured,
    json({
      role: "recording",
      framePath: "gpu",
      encoder: "h264.rtvc",
      rotation: 0,
      contentRect,
      fromPts,
    }),
    0n,
    canvas.width,
    canvas.height,
  );

/** A capture agent on a Unix socket that records each connection's commands. */
async function fakeAgent(root: string) {
  const socketPath = join(root, "emulator-5554.sock");
  const peers: Socket[] = [];
  const commands: Buffer[][] = [];
  let onConnect = (_socket: Socket, _index: number) => {};
  const commandWaiters: Array<() => void> = [];
  const server: Server = createServer((socket) => {
    const index = peers.length;
    peers.push(socket);
    commands.push([]);
    let pending = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      for (;;) {
        const size = { 0x4b: 1, 0x52: 5, 0x55: 5, 0x43: 9, 0x53: 13 }[pending[0] ?? 0] ?? 0;
        if (!size || pending.length < size) break;
        commands[index]!.push(Buffer.from(pending.subarray(0, size)));
        pending = pending.subarray(size);
      }
      for (const waiter of commandWaiters.splice(0)) waiter();
    });
    onConnect(socket, index);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    peers,
    commands,
    onConnect(handler: typeof onConnect) {
      onConnect = handler;
    },
    /** Waits until connection `index` sent `count` commands. */
    async commandsOf(index: number, count: number) {
      while ((commands[index]?.length ?? 0) < count)
        await new Promise<void>((resolve) => commandWaiters.push(resolve));
      return commands[index]!;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const peer of peers) peer.destroy();
        server.close(() => resolve());
      }),
  };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "capture-recording-"));
  roots.push(root);
  const agent = await fakeAgent(root);
  // The host clock is 9 s ahead of the agent's clock.
  let nowUs = 10_000_000n;
  const samples: Array<{ isKey: boolean; timestamp: number }> = [];
  const recorder = await ScreenRecording.create({
    directory: join(root, "session"),
    udid: "emulator-5554",
    deviceName: "Pixel",
    runtimeDisplayName: "Android 37",
    clock: { monotonicUs: () => nowUs, epochMs: () => 1_700_000_000_000 },
    createWriter: async ({ path }) => {
      await writeFile(path, "test-writer");
      return {
        add: async (sample) => {
          samples.push({ isKey: sample.isKey, timestamp: sample.timestamp });
        },
        finish: async () => {},
        cancel: async () => {},
      };
    },
  });
  const manifest = async () =>
    JSON.parse(await readFile(join(root, "session", "session.json"), "utf8"));
  const start = (overrides: Partial<CaptureRecordingSourceOptions> = {}) =>
    startCaptureRecordingSource({
      serial: "emulator-5554",
      socketPath: agent.socketPath,
      recorder,
      encoding: { maxSize: 0, fps: 60, bitRate: 8_000_000 },
      displays: null,
      deviceOnline: async () => true,
      log: () => {},
      ...overrides,
    });
  return {
    root,
    agent,
    recorder,
    samples,
    manifest,
    start,
    advance(us: bigint) {
      nowUs += us;
    },
  };
}

const until = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("capture recording source", () => {
  test("takes the recording role with its canvas and its own settings", async () => {
    const { agent, start, recorder, samples } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs: 1_000_000 })));
    const source = await start({ encoding: { maxSize: 0, fps: 90, bitRate: 6_000_000 } });
    try {
      const commands = await agent.commandsOf(0, 3);
      // U(recording), C(native canvas), S(no cap, the recording's rate and bit rate).
      expect(commands.map((command) => [...command])).toEqual([
        [0x55, 0, 0, 0, 1],
        [0x43, 0, 0, 0x04, 0x38, 0, 0, 0x09, 0x78],
        [0x53, 0, 0, 0, 0, 0, 0, 0, 90, 0, 0x5b, 0x8d, 0x80],
      ]);
      expect(source.canvas).toEqual({ width: 1080, height: 2424 });
      expect(recorder.snapshot().status).toBe("waiting");

      const canvas = { width: 1080, height: 2424 };
      recorder.observePose({ orientation: "portrait" });
      agent.peers[0]!.write(
        Buffer.concat([
          configured(canvas, { x: 0, y: 0, width: 1080, height: 2424 }, 1_000_100),
          record(GPU_RECORD.keyFrame, keyFrame, 1_000_100n, 1080, 2424),
          record(GPU_RECORD.frame, delta, 1_016_767n, 1080, 2424),
          record(GPU_RECORD.frame, delta, 1_033_433n, 1080, 2424),
        ]),
      );
      await until(() => samples.length === 2);
      // Timestamps keep the agent's capture times; the first frame starts the file.
      expect(samples.map((sample) => [sample.isKey, sample.timestamp])).toEqual([
        [true, 0],
        [false, 0.016667],
      ]);
      expect(recorder.snapshot().status).toBe("recording");
    } finally {
      source.close();
      await agent.close();
    }
  });

  test("records the device state of every part, on the host clock", async () => {
    const { agent, start, recorder, manifest, advance } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs: 1_000_000 })));
    const source = await start();
    const canvas = { width: 1080, height: 2424 };
    recorder.observePose({ orientation: "portrait" });
    agent.peers[0]!.write(
      Buffer.concat([
        configured(canvas, { x: 0, y: 0, width: 1080, height: 2424 }, 1_000_100),
        record(GPU_RECORD.keyFrame, keyFrame, 1_000_100n, 1080, 2424),
      ]),
    );
    await until(() => recorder.snapshot().status === "recording");
    // The UI turns 0.5 s later on the host clock; the agent's frame 0.6 s later shows it.
    advance(500_000n);
    recorder.observePose({ orientation: "landscape_left" });
    agent.peers[0]!.write(
      Buffer.concat([
        record(GPU_RECORD.frame, delta, 1_600_100n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 1_700_100n, 1080, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 3);
    advance(500_000n);
    await recorder.finish();
    source.close();
    await agent.close();
    const result = await manifest();
    expect(result.width).toBe(1080);
    expect(result.height).toBe(2424);
    expect(result.deviceStates).toEqual([
      {
        timeMs: 0,
        state: {
          width: 1080,
          height: 2424,
          contentRect: { x: 0, y: 0, width: 1080, height: 2424 },
          orientation: "portrait",
        },
      },
      {
        timeMs: 600,
        state: {
          width: 1080,
          height: 2424,
          contentRect: { x: 0, y: 0, width: 1080, height: 2424 },
          orientation: "landscape_left",
        },
      },
    ]);
  });

  test("a fold keeps the canvas and moves the picture", async () => {
    const { agent, start, recorder, manifest, advance } = await setup();
    agent.onConnect((socket) =>
      socket.write(hello({ protocol: 3, clockUs: 1_000_000 }, 2076, 2152)),
    );
    let screenChanges = 0;
    const source = await start({
      displays: PIXEL_9_PRO_FOLD,
      onScreenChange: () => screenChanges++,
    });
    const commands = await agent.commandsOf(0, 3);
    // The bounding box of both displays.
    expect([...commands[1]!]).toEqual([0x43, 0, 0, 0x08, 0x1c, 0, 0, 0x09, 0x78]);
    expect(source.canvas).toEqual({ width: 2076, height: 2424 });
    expect(recorder.followsFold).toBe(true);
    const canvas = source.canvas;
    recorder.observePose({ hingeAngle: 180, orientation: "portrait" });
    agent.peers[0]!.write(
      Buffer.concat([
        configured(canvas, { x: 0, y: 136, width: 2076, height: 2152 }, 1_000_100),
        record(GPU_RECORD.keyFrame, keyFrame, 1_000_100n, 2076, 2424),
      ]),
    );
    await until(() => recorder.snapshot().status === "recording");
    advance(1_000_000n);
    recorder.observePose({ hingeAngle: 0 });
    agent.peers[0]!.write(
      Buffer.concat([
        record(GPU_RECORD.resized, Buffer.alloc(0), 0n, 1080, 2424),
        configured(canvas, { x: 498, y: 0, width: 1080, height: 2424 }, 2_000_100),
        record(GPU_RECORD.keyFrame, keyFrame, 2_000_100n, 2076, 2424),
        record(GPU_RECORD.frame, delta, 2_016_767n, 2076, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 3);
    expect(screenChanges).toBe(1);
    advance(1_100_000n);
    await recorder.finish();
    source.close();
    await agent.close();
    const result = await manifest();
    expect(result.deviceStates).toEqual([
      {
        timeMs: 0,
        state: {
          width: 2076,
          height: 2152,
          screen: "inner",
          contentRect: { x: 0, y: 136, width: 2076, height: 2152 },
          hingeAngle: 180,
          orientation: "portrait",
        },
      },
      {
        timeMs: 1000,
        state: {
          width: 1080,
          height: 2424,
          screen: "outer",
          contentRect: { x: 498, y: 0, width: 1080, height: 2424 },
          hingeAngle: 0,
          orientation: "portrait",
        },
      },
    ]);
  });

  test("refuses an agent without the recording role or without an encoder", async () => {
    const { agent, start } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 2 })));
    await expect(start()).rejects.toBeInstanceOf(GpuCaptureUnavailableError);
    expect(agent.commands[0]).toEqual([]);
    agent.onConnect((socket) =>
      socket.write(hello({ protocol: 3, clockUs: 1, encoderError: "install x264" })),
    );
    await expect(start()).rejects.toBeInstanceOf(GpuCaptureEncoderError);
    await agent.close();
  });

  test("refuses a socket that nothing answers", async () => {
    const { start, root } = await setup();
    await expect(start({ socketPath: join(root, "missing.sock") })).rejects.toBeInstanceOf(
      GpuCaptureUnavailableError,
    );
  });

  test("finishes at once with device-ended when the agent is gone", async () => {
    const { agent, start, recorder, manifest, advance } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs: 1_000_000 })));
    await start();
    agent.peers[0]!.write(
      Buffer.concat([
        configured({ width: 1080, height: 2424 }, { x: 0, y: 0, width: 1080, height: 2424 }, 1_000),
        record(GPU_RECORD.keyFrame, keyFrame, 1_000n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 17_667n, 1080, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 2);
    advance(2_000_000n);
    // The emulator exits: its agent removes the socket, and the connection closes.
    await agent.close();
    await unlink(agent.socketPath).catch(() => {});
    await until(() => recorder.snapshot().status === "complete");
    const result = await manifest();
    expect(result.status).toBe("complete");
    expect(result.stopReason).toBe("device-ended");
    expect(result.recording).toBe("recording.mp4");
    // A later stop request publishes the same recording.
    expect((await recorder.finish()).udid).toBe("emulator-5554");
  });

  test("finishes with device-ended when adb no longer lists the device", async () => {
    const { agent, start, recorder, manifest } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs: 1_000_000 })));
    let online = true;
    let connections = 0;
    agent.onConnect((socket) => {
      connections++;
      socket.write(hello({ protocol: 3, clockUs: 1_000_000 }));
    });
    await start({ deviceOnline: async () => online });
    agent.peers[0]!.write(
      Buffer.concat([
        configured({ width: 1080, height: 2424 }, { x: 0, y: 0, width: 1080, height: 2424 }, 1_000),
        record(GPU_RECORD.keyFrame, keyFrame, 1_000n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 17_667n, 1080, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 2);
    online = false;
    agent.peers[0]!.destroy();
    await until(() => recorder.snapshot().status === "complete");
    expect((await manifest()).stopReason).toBe("device-ended");
    expect(connections).toBe(1);
    await agent.close();
  });

  test("connects again when the agent drops the recording and the device still runs", async () => {
    const { agent, start, recorder, samples } = await setup();
    let clockUs = 1_000_000;
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs })));
    const source = await start();
    const canvas = { width: 1080, height: 2424 };
    const rect = { x: 0, y: 0, width: 1080, height: 2424 };
    agent.peers[0]!.write(
      Buffer.concat([
        configured(canvas, rect, 1_000_100),
        record(GPU_RECORD.keyFrame, keyFrame, 1_000_100n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 1_016_767n, 1080, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 2);
    clockUs = 3_000_000;
    agent.peers[0]!.destroy();
    const commands = await agent.commandsOf(1, 3);
    expect(commands.map((command) => command[0])).toEqual([0x55, 0x43, 0x53]);
    agent.peers[1]!.write(
      Buffer.concat([
        configured(canvas, rect, 3_000_100),
        record(GPU_RECORD.keyFrame, keyFrame, 3_000_100n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 3_016_767n, 1080, 2424),
      ]),
    );
    await until(() => samples.length === 3);
    expect(recorder.active).toBe(true);
    // The same agent's clock goes on, so the gap stays in the file.
    expect(samples.map((sample) => [sample.isKey, sample.timestamp])).toEqual([
      [true, 0],
      [false, 0.016667],
      [true, 2],
    ]);
    source.close();
    await agent.close();
  });

  test("a new agent on the same socket ends the device", async () => {
    const { agent, start, recorder, manifest } = await setup();
    let clockUs = 5_000_000;
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs })));
    await start();
    agent.peers[0]!.write(
      Buffer.concat([
        configured(
          { width: 1080, height: 2424 },
          { x: 0, y: 0, width: 1080, height: 2424 },
          5_000_100,
        ),
        record(GPU_RECORD.keyFrame, keyFrame, 5_000_100n, 1080, 2424),
        record(GPU_RECORD.frame, delta, 5_016_767n, 1080, 2424),
      ]),
    );
    await until(() => (recorder.snapshot() as { frames?: number }).frames === 2);
    // The emulator started again: its agent's clock starts over.
    clockUs = 2_000;
    agent.peers[0]!.destroy();
    await until(() => recorder.snapshot().status === "complete");
    expect((await manifest()).stopReason).toBe("device-ended");
    await agent.close();
  });

  test("another recording consumer fails the recording", async () => {
    const { agent, start, recorder } = await setup();
    agent.onConnect((socket) => socket.write(hello({ protocol: 3, clockUs: 1_000_000 })));
    await start();
    agent.peers[0]!.write(record(GPU_RECORD.replaced, Buffer.alloc(0), 0n, 0, 0));
    await until(() => recorder.snapshot().status === "failed");
    expect(recorder.snapshot()).toEqual({
      status: "failed",
      error: "Another program took over the emulator capture's recording.",
    });
    await agent.close();
  });
});

describe("capture recording defaults", () => {
  test("the frame rate is the display's refresh rate, capped at 120", () => {
    expect(displayRefreshRate("hw.lcd.width = 1080\nhw.lcd.vsync = 60\n")).toBe(60);
    expect(displayRefreshRate("hw.lcd.vsync = 90")).toBe(90);
    expect(displayRefreshRate("hw.lcd.vsync = 144")).toBe(120);
    expect(displayRefreshRate("hw.lcd.vsync = 0")).toBe(null);
    expect(displayRefreshRate("hw.lcd.width = 1080")).toBe(null);
    expect(displayRefreshRate(null)).toBe(null);
  });

  test("native size, the refresh rate and 8 Mbit/s unless the start asks otherwise", () => {
    expect(captureRecordingEncoding(undefined, "hw.lcd.vsync = 90")).toEqual({
      maxSize: 0,
      fps: 90,
      bitRate: 8_000_000,
    });
    expect(captureRecordingEncoding({}, null)).toEqual({
      maxSize: 0,
      fps: 60,
      bitRate: 8_000_000,
    });
    expect(
      captureRecordingEncoding({ maxSize: 1280, fps: 30, bitRate: 4_000_000 }, "hw.lcd.vsync = 90"),
    ).toEqual({ maxSize: 1280, fps: 30, bitRate: 4_000_000 });
  });

  test("the canvas is the native display, or a foldable's bounding box", () => {
    expect(captureRecordingCanvas({ width: 1080, height: 2424 }, null, 0)).toEqual({
      width: 1080,
      height: 2424,
    });
    expect(captureRecordingCanvas({ width: 1080, height: 2424 }, null, 1280)).toEqual({
      width: 570,
      height: 1280,
    });
    expect(captureRecordingCanvas({ width: 2076, height: 2152 }, PIXEL_9_PRO_FOLD, 0)).toEqual({
      width: 2076,
      height: 2424,
    });
    // Each display is capped first: 1234x1280 inner and 570x1280 outer.
    expect(captureRecordingCanvas({ width: 2076, height: 2152 }, PIXEL_9_PRO_FOLD, 1280)).toEqual({
      width: 1234,
      height: 1280,
    });
  });
});
