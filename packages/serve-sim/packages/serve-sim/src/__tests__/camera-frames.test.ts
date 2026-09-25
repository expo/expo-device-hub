import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import net from "net";
import { dirname } from "path";
import { cameraHelperSocketFile } from "../camera-helper";
import {
  cameraFrameStreamLost,
  claimCameraFrameStream,
  closeCameraFrameStream,
  closeCameraFrameStreams,
  writeCameraFrame,
} from "../camera-frames";

const owners: symbol[] = [];
const servers: net.Server[] = [];
const peers: net.Socket[] = [];
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function owner(): symbol {
  const value = Symbol();
  owners.push(value);
  return value;
}

async function until(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("camera transport condition timed out");
    await Bun.sleep(5);
  }
}

async function helper(connected: (socket: net.Socket) => void): Promise<string> {
  const udid = randomUUID();
  const path = cameraHelperSocketFile(udid);
  mkdirSync(dirname(path), { recursive: true });
  const server = net.createServer((socket) => {
    peers.push(socket);
    connected(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return udid;
}

afterEach(async () => {
  for (const value of owners.splice(0)) closeCameraFrameStreams(value);
  for (const socket of peers.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

test("accepts a split handshake and sends length-prefixed frame bytes", async () => {
  let peer: net.Socket | undefined;
  let handshake = "";
  const received: Buffer[] = [];
  const udid = await helper((socket) => {
    peer = socket;
    socket.once("data", (chunk) => {
      handshake = chunk.toString();
      socket.write('{"ok":');
      socket.on("data", (data: Buffer) => received.push(data));
    });
  });
  const sender = owner();
  claimCameraFrameStream(udid, sender);
  expect(writeCameraFrame(udid, frame, sender)).toBe(false);
  await until(() => handshake.length > 0);
  expect(JSON.parse(handshake)).toEqual({ action: "frames" });
  expect(writeCameraFrame(udid, frame, sender)).toBe(false);
  peer!.write("true}\n");
  await until(() => writeCameraFrame(udid, frame, sender));
  await until(() => received.length > 0);
  const bytes = Buffer.concat(received);
  expect(bytes.readUInt32BE()).toBe(frame.length);
  expect(bytes.subarray(4)).toEqual(frame);
});

test("old owner teardown cannot disconnect a replacement stream", async () => {
  let connections = 0;
  let latest: net.Socket | undefined;
  const udid = await helper((socket) => {
    connections++;
    latest = socket;
    socket.once("data", () => socket.write('{"ok":true}\n'));
  });
  const first = owner();
  const second = owner();
  claimCameraFrameStream(udid, first);
  await until(() => writeCameraFrame(udid, frame, first));
  claimCameraFrameStream(udid, second);
  await until(() => writeCameraFrame(udid, frame, second));
  for (let i = 0; i < 10; i++) expect(writeCameraFrame(udid, frame, first)).toBe(false);
  closeCameraFrameStreams(first);
  closeCameraFrameStream(udid, first);
  await Bun.sleep(20);
  expect(writeCameraFrame(udid, frame, second)).toBe(true);
  expect(connections).toBe(2);
  expect(latest!.destroyed).toBe(false);
  closeCameraFrameStream(udid, second);
  await until(() => latest!.destroyed);
  expect(writeCameraFrame(udid, frame, second)).toBe(false);
  claimCameraFrameStream(udid, second);
  await until(() => writeCameraFrame(udid, frame, second));
  expect(connections).toBe(3);
});

test("rejects a handshake that exceeds its bound", async () => {
  let peer: net.Socket | undefined;
  const udid = await helper((socket) => {
    peer = socket;
    socket.once("data", () => socket.write(Buffer.alloc(4097, 32)));
  });
  const sender = owner();
  claimCameraFrameStream(udid, sender);
  expect(writeCameraFrame(udid, frame, sender)).toBe(false);
  await until(() => !!peer?.destroyed);
});

test("closes an incomplete handshake at its deadline", async () => {
  let peer: net.Socket | undefined;
  const udid = await helper((socket) => {
    peer = socket;
    socket.once("data", () => socket.write('{"ok":'));
  });
  const sender = owner();
  claimCameraFrameStream(udid, sender);
  expect(writeCameraFrame(udid, frame, sender)).toBe(false);
  await until(() => !!peer?.destroyed, 4000);
}, 5000);

test("a helper that stops reading is dropped at the idle deadline while frames keep coming", async () => {
  let connections = 0;
  const udid = await helper((socket) => {
    connections++;
    socket.once("data", () => {
      socket.write('{"ok":true}\n');
      socket.pause();
    });
  });
  const sender = owner();
  claimCameraFrameStream(udid, sender);
  const large = Buffer.alloc(4 * 1024 * 1024, 1);
  await until(() => writeCameraFrame(udid, large, sender));
  const sending = setInterval(() => writeCameraFrame(udid, large, sender), 100);
  try {
    await until(() => connections > 1, 12_000);
  } finally {
    clearInterval(sending);
  }
}, 15_000);


test("unclaimed senders cannot open a stream, and a socket failure preserves the claim", async () => {
  let connections = 0;
  let latest: net.Socket | undefined;
  const udid = await helper((socket) => {
    connections++;
    latest = socket;
    socket.once("data", () => socket.write('{"ok":true}\n'));
  });
  const sender = owner();
  const stranger = owner();
  expect(writeCameraFrame(udid, frame, sender)).toBe(false);
  await Bun.sleep(20);
  expect(connections).toBe(0);
  claimCameraFrameStream(udid, sender);
  await until(() => writeCameraFrame(udid, frame, sender));
  latest!.destroy();
  await Bun.sleep(20);
  expect(writeCameraFrame(udid, frame, stranger)).toBe(false);
  await until(() => writeCameraFrame(udid, frame, sender));
  expect(connections).toBe(2);
});

test("a helper that refuses the stream ends the claim instead of retrying every frame", async () => {
  let handshakes = 0;
  const udid = await helper((socket) => {
    socket.once("data", () => {
      handshakes++;
      socket.write('{"ok":false,"error":"Select the stream source before sending frames."}\n');
    });
  });
  const sender = owner();
  claimCameraFrameStream(udid, sender);
  expect(cameraFrameStreamLost(udid)).toBe(false);
  writeCameraFrame(udid, frame, sender);
  await until(() => cameraFrameStreamLost(udid));
  for (let i = 0; i < 5; i++) writeCameraFrame(udid, frame, sender);
  await Bun.sleep(50);
  expect(handshakes).toBe(1);

  claimCameraFrameStream(udid, owner());
  expect(cameraFrameStreamLost(udid)).toBe(false);
});

test("a device with no helper socket has lost its stream", () => {
  expect(cameraFrameStreamLost(randomUUID())).toBe(true);
});
