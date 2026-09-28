import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, statSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import net from "net";
import { tmpdir } from "os";
import { join } from "path";

const HELPER_PATH = process.env.SERVE_SIM_CAMERA_HELPER_PATH ?? join(import.meta.dir, "../../dist/simcam/serve-sim-camera-helper");
const HEADER_BYTES = 64;
const CONTROL_BYTES = HEADER_BYTES + 4 + 4 + 4 * 4;
// A 16x16 JPEG, so the test carries a real encoded frame without a fixture file.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAEAAQAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAQEBAQEBAgEBAgICAgICAwICAgIDBAMDAwMDBAUEBAQEBAQFBQUFBQUFBQYGBgYGBgcHBwcHCAgICAgICAgICP/bAEMBAQEBAgICAwICAwgFBQUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICP/dAAQAAf/aAAwDAQACEQMRAD8A/F+iiiv8pz/v4P/Z",
  "base64",
);

function helperReady(): boolean {
  try {
    return statSync(HELPER_PATH).isFile();
  } catch {
    return false;
  }
}

const shouldRun = process.platform === "darwin" && helperReady();

async function openShmSeqReader(name: string): Promise<{ seq(): bigint; active(): boolean; close(): void }> {
  const { dlopen, FFIType, toArrayBuffer } = await import("bun:ffi");
  const sys = dlopen("libSystem.dylib", {
    shm_open: { args: [FFIType.cstring, FFIType.i32, FFIType.u16], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    munmap: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i32 },
    mmap: {
      args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64],
      returns: FFIType.ptr,
    },
  });
  const fd = Number(sys.symbols.shm_open(Buffer.from(`${name}\0`) as never, 0, 0));
  if (fd < 0) throw new Error(`shm_open(${name}) failed`);
  const ptr = sys.symbols.mmap(null as never, BigInt(CONTROL_BYTES) as never, 1, 1, fd, 0n as never);
  const view = new DataView(toArrayBuffer(ptr as never, 0, CONTROL_BYTES));
  sys.symbols.close(fd);
  return {
    seq: () => view.getBigUint64(32, true),
    active: () => view.getUint8(49) === 1,
    close: () => { sys.symbols.munmap(ptr as never, BigInt(CONTROL_BYTES) as never); sys.close(); },
  };
}

async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Opens a control connection and runs one command, keeping the socket open. */
function connectAndSend(socketPath: string, command: object): Promise<{
  socket: net.Socket;
  reply: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("helper never answered"));
    }, 5000);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve({ socket, reply: JSON.parse(buffer.slice(0, newline)) as Record<string, unknown> });
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(`${JSON.stringify(command)}\n`);
  });
}

function writeFrame(socket: net.Socket, frame: Buffer): void {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(frame.length, 0);
  socket.write(Buffer.concat([header, frame]));
}

const describeIf = shouldRun ? describe : describe.skip;

describeIf("SimCameraHelper pushed frames", () => {
  const tag = `${process.pid.toString(36)}${Date.now().toString(36)}`.slice(-10);
  const shmName = `/sscam-psh-${tag}`;
  const socketPath = `/tmp/sscam-psh-${tag}.sock`;
  const scratch = mkdtempSync(join(tmpdir(), "serve-sim-frame-test-"));
  const imagePath = join(scratch, "tiny.jpg");
  const largeImagePath = join(scratch, "large.bmp");
  let helper: ChildProcess | null = null;
  let header: Awaited<ReturnType<typeof openShmSeqReader>>;
  const sockets: net.Socket[] = [];

  async function command(value: object) {
    const result = await connectAndSend(socketPath, value);
    sockets.push(result.socket);
    return result;
  }
  async function switchSource(source: string, arg?: string) {
    const result = await command({ action: "switch", source, arg });
    result.socket.end();
    expect(result.reply.ok).toBe(true);
  }
  async function stream(): Promise<net.Socket> {
    const result = await command({ action: "frames" });
    expect(result.reply.ok).toBe(true);
    expect(result.reply.source).toBe("stream");
    return result.socket;
  }
  async function publish(socket: net.Socket): Promise<void> {
    const before = header.seq();
    writeFrame(socket, TINY_JPEG);
    expect(await waitFor(() => header.seq() === before + 1n && header.active(), 3000)).toBe(true);
  }
  function closed(socket: net.Socket): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 3000);
      socket.once("close", () => { clearTimeout(timeout); resolve(true); });
      socket.on("error", () => {});
    });
  }

  beforeAll(async () => {
    writeFileSync(imagePath, TINY_JPEG);
    const side = 2048;
    const bmp = Buffer.alloc(54 + side * side * 3);
    bmp.fill(0x80, 54);
    bmp.write("BM"); bmp.writeUInt32LE(bmp.length, 2); bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(side, 18); bmp.writeInt32LE(side, 22);
    bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28); bmp.writeUInt32LE(side * side * 3, 34);
    writeFileSync(largeImagePath, bmp);
    helper = spawn(HELPER_PATH,
      ["--shm", shmName, "--socket", socketPath, "--source", "stream"],
      { stdio: ["ignore", "ignore", "ignore"] });
    expect(await waitFor(() => existsSync(socketPath), 5000)).toBe(true);
    header = await openShmSeqReader(shmName);
    expect(header.active()).toBe(false);
    expect(header.seq()).toBe(0n);
  }, 15_000);

  beforeEach(async () => { await switchSource("stream"); });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    helper?.kill("SIGTERM");
    expect(await waitFor(() => helper?.exitCode !== null || helper?.signalCode !== null, 5000)).toBe(true);
    header?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("handshake cannot replace a source selected by the host", async () => {
    await switchSource("image", imagePath);
    const result = await command({ action: "frames" });
    expect(result.reply.ok).toBe(false);
    expect(result.reply.source).toBe("image");
    expect(result.reply.connected).toBe(true);
    result.socket.end();
  });

  test("connects only after a valid frame and disconnects when the sender closes", async () => {
    const socket = await stream();
    expect(header.active()).toBe(false);
    const before = header.seq();
    writeFrame(socket, Buffer.from("not an image"));
    await Bun.sleep(250);
    expect(header.seq()).toBe(before);
    expect(header.active()).toBe(false);
    await publish(socket);
    socket.end();
    expect(await waitFor(() => !header.active(), 500)).toBe(true);
  });

  test("idle feed disconnects and a new valid frame reconnects", async () => {
    const socket = await stream();
    await publish(socket);
    expect(await waitFor(() => !header.active(), 3500)).toBe(true);
    await publish(socket);
    socket.end();
  }, 10_000);

  test("an old sender cannot publish or disconnect a newer sender", async () => {
    const old = await stream();
    await publish(old);
    const current = await stream();
    await publish(current);
    const before = header.seq();
    writeFrame(old, TINY_JPEG);
    await Bun.sleep(250);
    expect(header.seq()).toBe(before);
    old.end();
    await Bun.sleep(250);
    expect(header.active()).toBe(true);
    await publish(current);
    current.end();
  });

  test("switching from a connected stream to an image never reports a disconnect", async () => {
    const socket = await stream();
    await publish(socket);
    let dropped = false;
    const sampler = setInterval(() => { if (!header.active()) dropped = true; }, 0);
    try {
      await switchSource("image", largeImagePath);
    } finally {
      clearInterval(sampler);
    }
    expect(dropped).toBe(false);
    expect(header.active()).toBe(true);
    socket.end();
  });

  test("switching away and back invalidates the old stream", async () => {
    const old = await stream();
    await publish(old);
    await switchSource("image", imagePath);
    const imageSeq = header.seq();
    writeFrame(old, TINY_JPEG);
    await Bun.sleep(250);
    expect(header.seq()).toBe(imageSeq);
    await switchSource("stream");
    writeFrame(old, TINY_JPEG);
    await Bun.sleep(250);
    expect(header.seq()).toBe(imageSeq);
    expect(header.active()).toBe(false);
    const current = await stream();
    await publish(current);
    old.end();
    await Bun.sleep(250);
    expect(header.active()).toBe(true);
    current.end();
  });

  test("rejects large decoded dimensions before allocating the image", async () => {
    const socket = await stream();
    const wide = Buffer.alloc(54 + 5000 * 3);
    wide.write("BM"); wide.writeUInt32LE(wide.length, 2); wide.writeUInt32LE(54, 10);
    wide.writeUInt32LE(40, 14); wide.writeInt32LE(5000, 18); wide.writeInt32LE(1, 22);
    wide.writeUInt16LE(1, 26); wide.writeUInt16LE(24, 28); wide.writeUInt32LE(15000, 34);
    const before = header.seq();
    writeFrame(socket, wide);
    await Bun.sleep(500);
    expect(header.seq()).toBe(before);
    expect(header.active()).toBe(false);
    await publish(socket);
    socket.end();
  });

  test("oversized frames and unfinished control lines close only that connection", async () => {
    const socket = await stream();
    const frameClosed = closed(socket);
    const size = Buffer.alloc(4); size.writeUInt32BE(64 * 1024 * 1024);
    socket.write(size);
    expect(await frameClosed).toBe(true);
    const control = net.createConnection(socketPath);
    sockets.push(control);
    const controlClosed = closed(control);
    control.write(Buffer.alloc(70 * 1024, 0x20));
    expect(await controlClosed).toBe(true);
    const status = await command({ action: "status" });
    expect(status.reply.ok).toBe(true);
    expect(status.reply.connected).toBe(false);
    status.socket.end();
  }, 10_000);
});
