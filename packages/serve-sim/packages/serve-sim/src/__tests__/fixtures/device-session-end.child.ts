import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import {
  inProcessServeSimState,
  stateDir,
  stateFileForDevice,
  writeServeSimState,
} from "../../state";

const PHONE = "00008101-0016603236F0801E";
const INPUT_PHONE = "00008101-0000000000000002";
const VIEWED_PHONE = "00008101-0000000000000003";
const SIMULATOR = "00000000-0000-0000-0000-000000000444";
const BUSY_PHONE = "00008101-0000000000000004";

const endListeners = new Map<string, (json: string) => Promise<void>>();
let nativeStops = 0;
const nativeStarts: string[] = [];
let deviceOptionReads: string[] = [];
const kinds: Array<{ udid: string; hid?: string; capture?: string }> = [];
const hidCalls: string[] = [];

class Hid {
  inputUnavailable = false;
  keyboardUnavailable = false;
  constructor(udid: string, kind: string) {
    kinds.push({ udid, hid: kind });
  }
  async button(name: string) {
    hidCalls.push(`button ${name}`);
  }
  async buttonHid(page: number, usage: number) {
    hidCalls.push(`buttonHid ${page}/${usage}`);
  }
  async orientation(value: number) {
    hidCalls.push(`orientation ${value}`);
    return true;
  }
  async caDebug() {
    hidCalls.push("caDebug");
    return true;
  }
  async memoryWarning() {
    hidCalls.push("memoryWarning");
  }
  async digitalCrown() {
    hidCalls.push("digitalCrown");
  }
  async softwareKeyboard() {
    hidCalls.push("softwareKeyboard");
  }
  async touch(type: string) {
    hidCalls.push(`touch ${type}`);
  }
  async setScreen() {}
  async supportsHingeAngle() {
    return false;
  }
  async supportsPhysicalOrientation() {
    return false;
  }
  async hingeState() {
    return {};
  }
}
class Capture {
  constructor(
    private readonly udid: string,
    _options: unknown,
    _screenId: unknown,
    kind: string,
  ) {
    kinds.push({ udid, capture: kind });
  }
  async start() {
    nativeStarts.push(this.udid);
  }
  async stop() {
    nativeStops++;
  }
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeMjpeg() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async subscribeEnd(onEnd: (end: { reason: string }) => Promise<void>) {
    endListeners.set(this.udid, (json) => onEnd(JSON.parse(json)));
    return async () => {};
  }
  async screenSize() {
    return { width: 1170, height: 2532, screenId: 1, orientation: "portrait" };
  }
}
mock.module("../../native", () => ({ ...native, NativeHid: Hid, NativeCapture: Capture }));
mock.module("../../ui-settings", () => ({
  ...ui,
  refreshDeviceOptionState: async (udid: string) => {
    deviceOptionReads.push(udid);
  },
}));
const { getDeviceSession, peekDeviceSession, startDeviceSession } =
  await import("../../device-session");
const { deviceEndConfig } = await import("../../device-end");

class Socket extends EventEmitter {
  closed?: { code?: number; reason?: string };
  sent: Buffer[] = [];
  send(data: Buffer) {
    this.sent.push(Buffer.from(data));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.emit("close");
  }
}

async function settle() {
  for (let i = 0; i < 5; i++) await Bun.sleep(5);
}

function message(tag: number, body?: unknown): Buffer {
  return body === undefined
    ? Buffer.from([tag])
    : Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);
}

test("a phone's session opens physical capture and HID", async () => {
  const session = getDeviceSession(INPUT_PHONE);
  await session.start();
  await settle();

  expect(kinds.filter((kind) => kind.udid === INPUT_PHONE)).toEqual([
    { udid: INPUT_PHONE, hid: "physical" },
    { udid: INPUT_PHONE, capture: "physical" },
  ]);
});

test("a phone takes touch and Home, and ignores simulator-only input", async () => {
  const session = getDeviceSession(INPUT_PHONE);
  await session.start();
  const socket = new Socket();
  session.attachHidSocket(socket as never);
  await settle();
  hidCalls.length = 0;

  for (const input of [
    message(0x03, { type: "begin", x: 0.5, y: 0.5 }),
    message(0x03, { type: "end", x: 0.5, y: 0.5 }),
    message(0x04, { button: "home" }),
    message(0x04, { button: "lock" }),
    message(0x04, { button: "power", page: 12, usage: 48, phase: "press" }),
    message(0x07, { orientation: "landscape_left" }),
    message(0x08, { option: "debug_color_blended", enabled: true }),
    message(0x09),
    message(0x0a, { delta: 1 }),
    message(0x0c),
    message(0x0e, { enabled: false }),
  ]) {
    socket.emit("message", input);
    await settle();
  }
  socket.emit("message", message(0x12, { requestId: 7, text: "hello" }));
  await settle();

  expect(hidCalls).toEqual(["touch begin", "touch end", "button home"]);
  const reply = socket.sent.find((frame) => frame[0] === 0x92);
  expect(JSON.parse(reply!.subarray(1).toString())).toEqual({
    requestId: 7,
    ok: false,
    error: "Clipboard is not available on a physical device.",
  });
  await session.close();
});

test("a disconnected phone ends its session with the reason", async () => {
  nativeStops = 0;
  writeServeSimState(inProcessServeSimState(PHONE, 3200));
  const session = getDeviceSession(PHONE);
  await session.start();
  const socket = new Socket();
  session.attachHidSocket(socket as never);
  await settle();
  expect(endListeners.has(PHONE)).toBe(true);
  expect(deviceOptionReads).toEqual([]);

  await endListeners.get(PHONE)!(JSON.stringify({ reason: "device-disconnected" }));
  await settle();

  expect(socket.closed).toEqual({ code: 4410, reason: "iPhone disconnected" });
  expect(peekDeviceSession(PHONE)).toBeUndefined();
  expect(existsSync(stateFileForDevice(PHONE))).toBe(false);
  expect(nativeStops).toBe(1);
  expect(deviceEndConfig(PHONE)).toEqual({
    device: PHONE,
    ended: { reason: "iPhone disconnected" },
  });
});

test("a phone's video viewers see their stream end with the session", async () => {
  const session = getDeviceSession(VIEWED_PHONE);
  await session.start();
  const server = createServer((req, res) => session.handleMjpeg(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = fetch(`http://127.0.0.1:${port}/stream.mjpeg`);
    await settle();

    await endListeners.get(VIEWED_PHONE)!(JSON.stringify({ reason: "device-disconnected" }));
    const read = await Promise.race([
      (async () => {
        const body = (await response).body!.getReader();
        while (!(await body.read()).done);
        return "ended";
      })(),
      Bun.sleep(1000).then(() => "still open"),
    ]);

    expect(read).toBe("ended");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("an ended phone opens no session until it is started again", async () => {
  expect(() => getDeviceSession(PHONE)).toThrow("iPhone disconnected");
  expect(peekDeviceSession(PHONE)).toBeUndefined();

  const session = await startDeviceSession(PHONE, undefined);

  expect(peekDeviceSession(PHONE)).toBe(session);
  expect(deviceEndConfig(PHONE)).toBeNull();
  await session.close();
});

test("a simulator's session does not wait for a device end", async () => {
  deviceOptionReads = [];
  const session = getDeviceSession(SIMULATOR);
  await session.start();
  await settle();

  expect(endListeners.has(SIMULATOR)).toBe(false);
  expect(deviceOptionReads).toEqual([SIMULATOR]);
  await session.close();
});

test("a phone that another server streams is refused before its capture starts", async () => {
  const lock = join(stateDir(), `physical-stream-${BUSY_PHONE}.lock`);
  writeFileSync(lock, String(process.ppid));
  try {
    await expect(startDeviceSession(BUSY_PHONE, undefined)).rejects.toThrow(
      `iPhone is streaming in another serve-sim (pid ${process.ppid})`,
    );
    expect(nativeStarts).not.toContain(BUSY_PHONE);
    expect(peekDeviceSession(BUSY_PHONE)).toBeUndefined();
  } finally {
    rmSync(lock, { force: true });
  }
});

test("a phone's session holds its stream until it closes", async () => {
  const lock = join(stateDir(), `physical-stream-${BUSY_PHONE}.lock`);
  const session = await startDeviceSession(BUSY_PHONE, undefined);

  expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
  await session.close();
  expect(existsSync(lock)).toBe(false);
});
