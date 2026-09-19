import { describe, expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { startGpuExperimentSession } from "../src/gpu-session.ts";
import { gpuSettingsCommand } from "../src/gpu-packet.ts";
import type { ScrcpyControlSession } from "../src/scrcpy.ts";
import type {
  EmuSession,
  StartEmuSessionOptions,
} from "../src/stream-session.ts";

const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x20]);
const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
const picture = Buffer.concat([sps, pps, idr]);

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

const hello = record(2, undefined, 0n, 1440, 2560);
const acknowledgement = record(3);
const firstFrame = record(1, picture, 1n);
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
      commands = Buffer.concat([
        commands,
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      ]);
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
    async start(
      overrides: Partial<StartEmuSessionOptions> = {},
      path = socketPath,
    ) {
      const session = await startGpuExperimentSession(
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
  test("negotiates settings and exposes decodable H.264 with native diagnostics", async () => {
    const fixture = await gpuFixture();
    try {
      const session = await fixture.start();
      expect(await fixture.settings).toEqual(
        gpuSettingsCommand(1280, 60, 8_000_000),
      );
      expect(session.meta).toMatchObject({
        width: 720,
        height: 1280,
        codecId: "h264",
      });
      expect(await session.readFrame()).toMatchObject({
        data: Buffer.concat([sps, pps]),
        isConfig: true,
      });
      expect(await session.readFrame()).toMatchObject({
        data: idr,
        isKey: true,
        pts: 1n,
      });
      expect(session.diagnostics?.().experimentalGpuCapture).toMatchObject({
        backend: "gfxstream-cuda-nvenc",
        encoderName: "h264_nvenc",
        nativeSize: { width: 1440, height: 2560 },
        streamSize: { width: 720, height: 1280 },
        fps: 60,
        packets: 1,
        bytes: picture.length,
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

  test.each([
    { name: "missing hello", bytes: acknowledgement, error: "does not match" },
    {
      name: "second hello",
      bytes: Buffer.concat([hello, hello]),
      error: "second GPU stream handshake",
    },
    {
      name: "wrong geometry",
      bytes: Buffer.concat([hello, record(3, undefined, 0n, 722)]),
      error: "does not match",
    },
    {
      name: "wrong FPS",
      bytes: Buffer.concat([hello, record(3, undefined, 0n, 720, 1280, 30)]),
      error: "does not match",
    },
    {
      name: "second acknowledgement",
      bytes: Buffer.concat([hello, acknowledgement, acknowledgement]),
      error: "second GPU settings acknowledgement",
    },
    {
      name: "frame before acknowledgement",
      bytes: Buffer.concat([hello, firstFrame]),
      error: "before settings acknowledgement",
    },
  ])(
    "rejects $name and releases the serial after startup failure",
    async ({ bytes, error }) => {
      const fixture = await gpuFixture();
      try {
        fixture.onConnect((socket) => {
          socket.write(bytes);
        });
        await expect(fixture.start()).rejects.toThrow(error);
        expect(fixture.controls).toHaveLength(0);
        fixture.onConnect((socket) => {
          socket.write(readyStream);
        });
        await fixture.start();
      } finally {
        await fixture.close();
      }
    },
  );

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
        fixture.send(record(1, idr, pts));
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
      await expect(fixture.start({ signal: abort.signal })).rejects.toThrow(
        "startup cancelled",
      );
      fixture.onConnect((socket) => {
        socket.write(readyStream);
      });
      await fixture.start();
    } finally {
      await fixture.close();
    }
  });

  test("rejects a truncated native stream during startup", async () => {
    const fixture = await gpuFixture();
    try {
      fixture.onConnect((socket) => socket.end(hello.subarray(0, 16)));
      await expect(fixture.start()).rejects.toThrow(
        "Truncated GPU stream record",
      );
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
