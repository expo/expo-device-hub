import { describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import {
  availableStreamModesForSerial,
  emulatorCaptureAvailability,
  emulatorCaptureSocketFor,
} from "../src/device-capabilities.ts";
import {
  GpuCaptureUnavailableError,
  startGpuCaptureSession,
  uprightTouchSize,
} from "../src/gpu-session.ts";
import { GPU_RECORD, gpuRotationCommand, gpuSettingsCommand } from "../src/gpu-packet.ts";
import type { ScrcpyControlSession } from "../src/scrcpy.ts";
import type { EmuSession, StartEmuSessionOptions } from "../src/stream-session.ts";

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x20]);
const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
const picture = Buffer.concat([sps, pps, idr]);
const foldedSps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x1f]);

function record(
  flags: number,
  data = Buffer.alloc(0),
  pts = 0n,
  width = 720,
  height = 1280,
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
const hello = record(GPU_RECORD.hello, json({ protocol: 1 }), 0n, 1440, 2560);
const acknowledgement = record(
  GPU_RECORD.configured,
  json({ framePath: "gpu", hardwareEncoder: true, encoder: "h264.rtvc" }),
);
const firstFrame = record(GPU_RECORD.keyFrame, picture, 1n);
const readyStream = Buffer.concat([hello, acknowledgement, firstFrame]);
// An agent that accepts the R command, ready at a stream size.
const rotatingStream = (width: number, height: number) =>
  Buffer.concat([
    record(GPU_RECORD.hello, json({ protocol: 2 }), 0n, 1440, 2560),
    record(GPU_RECORD.configured, json({ framePath: "gpu" }), 0n, width, height),
    record(GPU_RECORD.keyFrame, picture, 1n, width, height),
  ]);

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(check()).toBe(true);
}

async function gpuFixture() {
  // Keep the path within the macOS Unix socket length limit.
  const directory = await mkdtemp("/tmp/semu-gpu-");
  const socketPath = `${directory}/capture.sock`;
  const sockets = new Set<Socket>();
  const sessions: EmuSession[] = [];
  const controls: ScrcpyControlSession[] = [];
  let controlCloses = 0;
  let controlError: Error | null = null;
  let commands = Buffer.alloc(0);
  const parsedCommands: Buffer[] = [];
  let receivedSettings!: (command: Buffer) => void;
  const settings = new Promise<Buffer>((resolve) => {
    receivedSettings = resolve;
  });
  // K is one byte, R five and S thirteen.
  const parseCommands = () => {
    for (;;) {
      const size = commands[0] === 0x4b ? 1 : commands[0] === 0x52 ? 5 : 13;
      if (commands.length === 0 || commands.length < size) return;
      const command = commands.subarray(0, size);
      commands = commands.subarray(size);
      parsedCommands.push(Buffer.from(command));
      if (command[0] === 0x53) receivedSettings(Buffer.from(command));
    }
  };
  let connect = (socket: Socket) => {
    socket.write(readyStream);
  };
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      commands = Buffer.concat([commands, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      parseCommands();
    });
    connect(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const options: StartEmuSessionOptions = {
    serial: "emulator-5554",
    mode: "emulator-capture",
    inputSource: "scrcpy",
    grpcImageMode: "mmap",
    maxSize: 1280,
    maxFps: 60,
    bitRate: 8_000_000,
  };
  return {
    directory,
    options,
    socketPath,
    settings,
    commands: () => parsedCommands,
    controls,
    controlCloses: () => controlCloses,
    onConnect(handler: typeof connect) {
      connect = handler;
    },
    failControl(error: Error | null) {
      controlError = error;
    },
    send(bytes: Buffer) {
      if (!peer) throw new Error("GPU fixture has no consumer");
      peer.write(bytes);
    },
    async start(
      overrides: Partial<StartEmuSessionOptions> = {},
      path = socketPath,
      timers: Pick<
        Parameters<typeof startGpuCaptureSession>[2] & {},
        "setInterval" | "clearInterval"
      > = {},
    ) {
      const session = await startGpuCaptureSession(
        { ...options, signal: AbortSignal.timeout(1_000), ...overrides },
        path,
        {
          ...timers,
          async startScrcpyControl() {
            if (controlError) throw controlError;
            const control: ScrcpyControlSession = {
              transport: "scrcpy-control",
              controlSocket: new Socket(),
              proc: new ChildProcess(),
              serial: options.serial,
              scid: "00000001",
              localPort: 0,
              async close() {
                controlCloses++;
                control.controlSocket.destroy();
              },
            };
            controls.push(control);
            return control;
          },
        },
      );
      sessions.push(session);
      return session;
    },
    async close() {
      await Promise.all(sessions.map((session) => session.close()));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("GPU capture session", () => {
  test("negotiates settings and exposes decodable H.264 with capture diagnostics", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start();
      expect(await fixture.settings).toEqual(gpuSettingsCommand(1280, 60, 8_000_000));
      expect(session.meta).toMatchObject({ width: 720, height: 1280, codecId: "h264" });
      expect(await session.readFrame()).toMatchObject({
        data: Buffer.concat([sps, pps]),
        isConfig: true,
      });
      expect(await session.readFrame()).toMatchObject({ data: idr, isKey: true, pts: 1n });
      expect(session.diagnostics?.().experimentalGpuCapture).toEqual({
        backend: "expo-emulator-capture",
        framePath: "gpu",
        hardwareEncoder: true,
        encoderName: "h264.rtvc",
        packets: 1,
        bytes: picture.length,
        requestedKeyFrames: 0,
        queuedBytes: 0,
        fps: 60,
        nativeSize: { width: 1440, height: 2560 },
        streamSize: { width: 720, height: 1280 },
        maxSize: 1280,
        resizes: 0,
        rotation: null,
        rotations: 0,
      });
      expect(fixture.controls).toHaveLength(1);
      const waiting = session.readFrame();
      await session.close();
      await session.close();
      expect(await waiting).toBeNull();
      expect(fixture.controlCloses()).toBe(1);
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("follows a fold: new touch geometry, a session packet, then the new configuration", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start();
      await session.readFrame();
      await session.readFrame();
      fixture.send(
        Buffer.concat([
          record(GPU_RECORD.resized, undefined, 0n, 1080, 2424),
          record(GPU_RECORD.configured, json({ framePath: "gpu" }), 0n, 570, 1280),
          record(GPU_RECORD.keyFrame, Buffer.concat([foldedSps, pps, idr]), 2n, 570, 1280),
        ]),
      );
      expect(await session.readFrame()).toEqual({
        type: "session",
        width: 570,
        height: 1280,
        clientResized: false,
      });
      expect(await session.readFrame()).toMatchObject({
        data: Buffer.concat([foldedSps, pps]),
        isConfig: true,
      });
      expect(await session.readFrame()).toMatchObject({ data: idr, isKey: true, pts: 2n });
      expect(session.meta).toMatchObject({ width: 570, height: 1280 });
      expect(session.diagnostics?.().experimentalGpuCapture).toMatchObject({
        nativeSize: { width: 1080, height: 2424 },
        streamSize: { width: 570, height: 1280 },
        resizes: 1,
      });
    } finally {
      await fixture.close();
    }
  });

  test("does not announce a session when a reconfiguration keeps the size", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start();
      await session.readFrame();
      await session.readFrame();
      fixture.send(Buffer.concat([acknowledgement, record(GPU_RECORD.keyFrame, picture, 2n)]));
      expect(await session.readFrame()).toMatchObject({ isConfig: true });
      expect(await session.readFrame()).toMatchObject({ isKey: true, pts: 2n });
    } finally {
      await fixture.close();
    }
  });

  test.each([
    { name: "missing hello", bytes: acknowledgement, error: "did not start with a handshake" },
    {
      name: "second hello",
      bytes: Buffer.concat([hello, hello]),
      error: "second GPU stream handshake",
    },
    {
      name: "wrong frame geometry",
      bytes: Buffer.concat([hello, acknowledgement, record(GPU_RECORD.keyFrame, picture, 1n, 722)]),
      error: "does not match",
    },
    {
      name: "wrong frame FPS",
      bytes: Buffer.concat([
        hello,
        acknowledgement,
        record(GPU_RECORD.keyFrame, picture, 1n, 720, 1280, 30),
      ]),
      error: "does not match",
    },
    {
      name: "frame before acknowledgement",
      bytes: Buffer.concat([hello, firstFrame]),
      error: "before settings acknowledgement",
    },
    {
      name: "details that are not an object",
      bytes: Buffer.concat([hello, record(GPU_RECORD.configured, Buffer.from("[]"))]),
      error: "JSON object",
    },
  ])("rejects $name and releases the serial after startup failure", async ({ bytes, error }) => {
    const fixture = await gpuFixture();
    try {
      fixture.onConnect((socket) => {
        socket.write(bytes);
      });
      const failure = fixture.start();
      await expect(failure).rejects.toThrow(error);
      await expect(failure).rejects.not.toBeInstanceOf(GpuCaptureUnavailableError);
      expect(fixture.controls).toHaveLength(0);
      fixture.onConnect((socket) => {
        socket.write(readyStream);
      });
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test.each([1n, 0n])(
    "rejects a non-increasing timestamp %s and replays the first failure",
    async (pts) => {
      const fixture = await gpuFixture();
      try {
        const session = await fixture.start();
        await session.readFrame();
        await session.readFrame();
        const waiting = session.readFrame();
        const failure = new Promise<string>((resolve) => {
          session.onFatal((event) => resolve(event.message));
        });
        fixture.send(record(GPU_RECORD.frame, idr, pts));
        expect(await failure).toBe("GPU stream timestamp did not increase");
        expect(await waiting).toBeNull();
        const replay: string[] = [];
        session.onFatal((event) => replay.push(event.message));
        fixture.controls[0]!.proc.emit("exit", 1, null);
        expect(replay).toEqual(["GPU stream timestamp did not increase"]);
      } finally {
        await fixture.close();
      }
    },
  );

  test("sends the display rotation before the settings, so the first session is upright", async () => {
    const fixture = await gpuFixture();
    try {
      fixture.onConnect((socket) => {
        socket.write(rotatingStream(1280, 720));
      });
      const session = await fixture.start({ readDisplayRotation: async () => 1 });
      await fixture.settings;
      expect(fixture.commands()).toEqual([
        gpuRotationCommand(1),
        gpuSettingsCommand(1280, 60, 8_000_000),
      ]);
      expect(session.meta).toMatchObject({ width: 1280, height: 720 });
      expect(session.diagnostics?.().experimentalGpuCapture).toMatchObject({
        rotation: 1,
        rotations: 0,
      });
    } finally {
      await fixture.close();
    }
  });

  test("passes a later rotation to the agent at the next poll or display change", async () => {
    const fixture = await gpuFixture();
    let rotation: 0 | 1 | 2 | 3 = 0;
    let poll: (() => void) | undefined;
    let cleared = 0;
    try {
      fixture.onConnect((socket) => {
        socket.write(rotatingStream(720, 1280));
      });
      const session = await fixture.start(
        { readDisplayRotation: async () => rotation },
        undefined,
        {
          setInterval: (callback) => {
            poll = callback;
            return {};
          },
          clearInterval: () => {
            cleared++;
          },
        },
      );
      await fixture.settings;
      // Rotation 0 needs no R command.
      expect(fixture.commands()).toEqual([gpuSettingsCommand(1280, 60, 8_000_000)]);
      rotation = 3;
      poll!();
      await until(() => fixture.commands().length === 2);
      expect(fixture.commands()[1]).toEqual(gpuRotationCommand(3));
      rotation = 2;
      session.displayChanged?.();
      await until(() => fixture.commands().length === 3);
      expect(fixture.commands()[2]).toEqual(gpuRotationCommand(2));
      // An unchanged rotation sends nothing.
      poll!();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fixture.commands()).toHaveLength(3);
      expect(session.diagnostics?.().experimentalGpuCapture).toMatchObject({
        rotation: 2,
        rotations: 2,
      });
      await session.close();
      expect(cleared).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("leaves an agent without the R command unrotated", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start({ readDisplayRotation: async () => 1 });
      await fixture.settings;
      expect(fixture.commands()).toEqual([gpuSettingsCommand(1280, 60, 8_000_000)]);
      expect(session.diagnostics?.().experimentalGpuCapture).toMatchObject({ rotation: null });
    } finally {
      await fixture.close();
    }
  });

  test("rejects overlapping consumers and permits a replacement after close", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start();
      await expect(fixture.start()).rejects.toThrow("already has a session");
      await session.close();
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("cleans up a failed scrcpy startup before allowing a retry", async () => {
    const fixture = await gpuFixture();
    try {
      fixture.failControl(new Error("scrcpy unavailable"));
      await expect(fixture.start()).rejects.toThrow("scrcpy unavailable");
      fixture.failControl(null);
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("aborts startup and releases the serial for a new session", async () => {
    const fixture = await gpuFixture();
    const abort = new AbortController();
    try {
      fixture.onConnect(() => abort.abort(new Error("startup cancelled")));
      await expect(fixture.start({ signal: abort.signal })).rejects.toThrow("startup cancelled");
      fixture.onConnect((socket) => {
        socket.write(readyStream);
      });
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("rejects a truncated stream as a broken agent, not a missing one", async () => {
    const fixture = await gpuFixture();
    try {
      fixture.onConnect((socket) => socket.end(hello.subarray(0, 16)));
      const failure = fixture.start();
      await expect(failure).rejects.toThrow("Truncated GPU stream record");
      await expect(failure).rejects.not.toBeInstanceOf(GpuCaptureUnavailableError);
    } finally {
      await fixture.close();
    }
  });

  test("reports an unavailable agent when nothing listens on the socket", async () => {
    const fixture = await gpuFixture();
    try {
      // A socket file left behind by an emulator that has exited.
      const stale = `${fixture.directory}/stale.sock`;
      await writeFile(stale, "");
      await expect(fixture.start({}, stale)).rejects.toBeInstanceOf(GpuCaptureUnavailableError);
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("does not reserve the serial when connection creation throws", async () => {
    const fixture = await gpuFixture();
    try {
      await expect(fixture.start({}, "/tmp/invalid\0socket")).rejects.toThrow();
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });
});

test("maps touches to the native display, upright for the rotation", () => {
  const native = { width: 1080, height: 2424 };
  expect(uprightTouchSize(native, 0)).toEqual({ width: 1080, height: 2424 });
  expect(uprightTouchSize(native, 1)).toEqual({ width: 2424, height: 1080 });
  expect(uprightTouchSize(native, 2)).toEqual({ width: 1080, height: 2424 });
  expect(uprightTouchSize(native, 3)).toEqual({ width: 2424, height: 1080 });
});

describe("emulator capture availability", () => {
  test("offers the mode only for an emulator whose agent serves a socket", async () => {
    const directory = await mkdtemp("/tmp/semu-gpu-");
    try {
      await writeFile(`${directory}/emulator-5554.sock`, "");
      expect(emulatorCaptureSocketFor("emulator-5554", directory)).toBe(
        `${directory}/emulator-5554.sock`,
      );
      expect(emulatorCaptureSocketFor("emulator-5554", undefined)).toBeNull();
      expect(emulatorCaptureSocketFor("emulator-5556", directory)).toBeNull();
      expect(emulatorCaptureSocketFor("R58M123456", directory)).toBeNull();

      const options = { socketDirectory: directory, missingAgentReason: "Restart it." };
      expect(emulatorCaptureAvailability("emulator-5554", options)).toEqual({
        socket: `${directory}/emulator-5554.sock`,
      });
      expect(emulatorCaptureAvailability("emulator-5556", options)).toEqual({
        socket: null,
        reason: "Restart it.",
      });
      expect(emulatorCaptureAvailability("R58M123456", options)).toMatchObject({ socket: null });
      // A function gives a reason that changes, such as an install in progress.
      expect(
        emulatorCaptureAvailability("emulator-5556", {
          socketDirectory: directory,
          missingAgentReason: () => "Installing the agent…",
        }),
      ).toEqual({ socket: null, reason: "Installing the agent…" });
      expect(
        emulatorCaptureAvailability("emulator-5554", { unavailableReason: "Turn it on." }),
      ).toEqual({ socket: null, reason: "Turn it on." });
      // An app that does not offer the mode gives no reason, so clients do not show it.
      expect(emulatorCaptureAvailability("emulator-5554", undefined)).toEqual({ socket: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("lists emulator-capture only when the caller says it is available", () => {
    expect(availableStreamModesForSerial("emulator-5554")).toEqual(["scrcpy", "grpc-screenshot"]);
    expect(availableStreamModesForSerial("emulator-5554", { emulatorCapture: true })).toEqual([
      "scrcpy",
      "grpc-screenshot",
      "emulator-capture",
    ]);
    expect(availableStreamModesForSerial("R58M123456", { emulatorCapture: true })).toEqual([
      "scrcpy",
    ]);
  });
});
