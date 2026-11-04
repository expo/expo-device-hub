import { describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { GpuCaptureUnavailableError, startGpuCaptureSession } from "../src/gpu-session.ts";
import { GPU_RECORD, gpuSettingsCommand } from "../src/gpu-packet.ts";
import type { ScrcpyControlSession } from "../src/scrcpy.ts";
import {
  experimentalGpuCaptureSocket,
  type EmuSession,
  type StartEmuSessionOptions,
} from "../src/stream-session.ts";

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
  let receivedSettings!: (command: Buffer) => void;
  const settings = new Promise<Buffer>((resolve) => {
    receivedSettings = resolve;
  });
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
      if (commands.length >= 13) receivedSettings(commands.subarray(0, 13));
    });
    connect(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const options: StartEmuSessionOptions = {
    serial: "emulator-5554",
    mode: "scrcpy",
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
    async start(overrides: Partial<StartEmuSessionOptions> = {}, path = socketPath) {
      const session = await startGpuCaptureSession(
        { ...options, signal: AbortSignal.timeout(1_000), ...overrides },
        path,
        {
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

describe("experimentalGpuCaptureSocket", () => {
  test("selects an emulator's socket only for scrcpy video and input", async () => {
    const directory = await mkdtemp("/tmp/semu-gpu-");
    try {
      await writeFile(`${directory}/emulator-5554.sock`, "");
      const options: StartEmuSessionOptions = {
        serial: "emulator-5554",
        mode: "scrcpy",
        inputSource: "scrcpy",
        grpcImageMode: "mmap",
        experimentalGpuCaptureSocketDirectory: directory,
      };
      expect(experimentalGpuCaptureSocket(options)).toBe(`${directory}/emulator-5554.sock`);
      expect(
        experimentalGpuCaptureSocket({
          ...options,
          experimentalGpuCaptureSocketDirectory: undefined,
        }),
      ).toBeNull();
      expect(experimentalGpuCaptureSocket({ ...options, mode: "grpc-screenshot" })).toBeNull();
      expect(experimentalGpuCaptureSocket({ ...options, inputSource: "grpc" })).toBeNull();
      expect(experimentalGpuCaptureSocket({ ...options, serial: "emulator-5556" })).toBeNull();
      expect(experimentalGpuCaptureSocket({ ...options, serial: "R58M123456" })).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
