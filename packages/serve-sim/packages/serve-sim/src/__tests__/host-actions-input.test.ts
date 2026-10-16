import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { InvalidHostActionError, runHostActionAsync } from "../host-actions";
import { inProcessServeSimState, writeServeSimState } from "../state";
import { UDID, installShims, useTempStateDir } from "./helpers";

const CLI = join(import.meta.dir, "../index.ts");
const TOKEN = "input-action-test";
const events = [
  { type: "begin", x: 0.2, y: 0.4, edge: 1 },
  { type: "move", x: 0.5, y: 0.6, delayMs: 80 },
  { type: "end", x: 0.8, y: 0.7 },
];
type Frame = { tag: number; payload?: unknown };
let state: ReturnType<typeof useTempStateDir>;
let shims: ReturnType<typeof installShims>;
let server: ReturnType<typeof Bun.serve> | undefined;
let timers: ReturnType<typeof setTimeout>[];

beforeEach(() => {
  state = useTempStateDir();
  // A synthetic state uses our PID; a real simctl lookup must never mark it stale and kill us.
  shims = installShims({ xcrun: "#!/bin/sh\nexit 1\n" });
  timers = [];
});
afterEach(() => {
  for (const timer of timers) clearTimeout(timer);
  server?.stop(true);
  server = undefined;
  shims.restore();
  state.restore();
});

function helper(mode: "success" | "refuse" | "interrupt" | "errorAck" | "earlyAck" | "slowAck" | "paced" = "success") {
  const frames: Frame[] = [];
  const authorization: Array<string | null> = [];
  const touchTimes: number[] = [], nativePhases: string[] = [];
  let pendingPhase = "", nativeTimer: ReturnType<typeof setTimeout> | undefined;
  let admitted = false, sentBeforeAdmission = false, acknowledged = false;
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, current) {
      authorization.push(request.headers.get("authorization"));
      if (current.upgrade(request, { data: undefined })) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      open(socket) {
        if (mode === "earlyAck") socket.send(Buffer.from([0x91, 1]));
        timers.push(setTimeout(() => {
          if (mode === "refuse") {
            socket.close(1013, "Simulator input unavailable");
            return;
          }
          admitted = true;
          socket.send(Buffer.from([0x83]));
          socket.send(Buffer.concat([Buffer.from([0x82]), Buffer.from(JSON.stringify({
            supportsHingeAngle: true, hingeAngle: 90,
          }))]));
        }, 50));
      },
      message(socket, data) {
        if (mode === "refuse") return;
        if (!admitted) sentBeforeAdmission = true;
        const bytes = Buffer.from(data);
        const tag = bytes[0]!;
        const payload = bytes.length > 1 ? JSON.parse(bytes.subarray(1).toString()) : undefined;
        frames.push({ tag, ...(payload === undefined ? {} : { payload }) });
        if (tag === 0x03) {
          touchTimes.push(performance.now());
          // Model a native event dispatch that retains only the last phase within one frame.
          if (mode === "paced") {
            pendingPhase = payload.type;
            if (!nativeTimer) {
              nativeTimer = setTimeout(() => { nativePhases.push(pendingPhase); nativeTimer = undefined; }, 16);
              timers.push(nativeTimer);
            }
          }
        }
        if (mode === "interrupt" && tag === 0x03) socket.close(1000, "Gesture interrupted");
        if (tag === 0x11) timers.push(setTimeout(() => {
          if (mode === "earlyAck") {
            socket.close(1000, "No final acknowledgement");
            return;
          }
          acknowledged = true;
          socket.send(Buffer.from([0x91, mode === "errorAck" ? 0 : 1]));
        }, mode === "slowAck" ? 250 : 40));
      },
    },
  });
  writeServeSimState({ ...inProcessServeSimState(UDID, server.port!), token: TOKEN });
  return { frames, authorization, touchTimes, nativePhases, beforeAdmission: () => sentBeforeAdmission, acknowledged: () => acknowledged };
}

function run(action: string, params: Record<string, unknown> = {}) {
  return runHostActionAsync({ action, params: { udid: UDID, ...params } }, CLI);
}

test("tap uses the authenticated, admitted input channel for begin and end", async () => {
  const observed = helper();
  const result = await run("tap", { x: 0.25, y: 0.75 });
  expect(result.exitCode).toBe(0);
  expect(observed.authorization).toEqual([`Bearer ${TOKEN}`]);
  expect(observed.beforeAdmission()).toBe(false);
  expect(observed.frames).toEqual([
    ...["begin", "end"].map(type => ({ tag: 0x03, payload: { type, x: 0.25, y: 0.75 } })),
    { tag: 0x11 },
  ]);
});

test("tap waits for native completion beyond its old fixed timers", async () => {
  const observed = helper("slowAck");
  expect((await run("tap", { x: 0.25, y: 0.75 })).exitCode).toBe(0);
  expect(observed.acknowledged()).toBe(true);
});

test("gesture keeps ordered events on one admitted connection until the final acknowledgement", async () => {
  const observed = helper();
  const result = await run("gesture", { events });
  expect(result.exitCode).toBe(0);
  expect(observed.authorization).toEqual([`Bearer ${TOKEN}`]);
  expect(observed.beforeAdmission()).toBe(false);
  expect(observed.frames).toEqual([
    { tag: 0x03, payload: { type: "begin", x: 0.2, y: 0.4, edge: 1 } },
    { tag: 0x03, payload: { type: "move", x: 0.5, y: 0.6 } },
    { tag: 0x03, payload: { type: "end", x: 0.8, y: 0.7 } },
    { tag: 0x11 },
  ]);
  expect(observed.acknowledged()).toBe(true);
});

test("gesture paces omitted delays so native dispatch observes every phase", async () => {
  const observed = helper("paced");
  const immediate = events.map(({ delayMs: _delayMs, ...event }) => event);
  expect((await run("gesture", { events: immediate })).exitCode).toBe(0);
  expect(observed.touchTimes).toHaveLength(3);
  expect(observed.touchTimes[1]! - observed.touchTimes[0]!).toBeGreaterThanOrEqual(25);
  expect(observed.touchTimes[2]! - observed.touchTimes[1]!).toBeGreaterThanOrEqual(25);
  expect(observed.nativePhases).toEqual(["begin", "move", "end"]);
});

test("type preserves leading dashes and whitespace and waits for keyboard completion", async () => {
  const observed = helper();
  const result = await run("type", { text: "--help\t\n\r" });
  expect(result.exitCode).toBe(0);
  expect(observed.authorization).toEqual([`Bearer ${TOKEN}`]);
  expect(observed.frames).toEqual([
    ...[0x2d, 0x2d, 0x0b, 0x08, 0x0f, 0x13, 0x2b, 0x28, 0x28].flatMap(usage => [
      { tag: 0x06, payload: { type: "down", usage } },
      { tag: 0x06, payload: { type: "up", usage } },
    ]),
    { tag: 0x11 },
  ]);
  expect(observed.acknowledged()).toBe(true);
});

test("type converts CRLF and lone CR to exactly one Enter each", async () => {
  const observed = helper();
  expect((await run("type", { text: "a\r\nb\rc" })).exitCode).toBe(0);
  expect(observed.frames).toEqual([
    ...[0x04, 0x28, 0x05, 0x28, 0x06].flatMap(usage => [
      { tag: 0x06, payload: { type: "down", usage } },
      { tag: 0x06, payload: { type: "up", usage } },
    ]),
    { tag: 0x11 },
  ]);
});

test("type accepts empty text without injecting a key", async () => {
  const observed = helper();
  expect((await run("type", { text: "" })).exitCode).toBe(0);
  expect(observed.frames).toEqual([{ tag: 0x11 }]);
  expect(observed.acknowledged()).toBe(true);
});

test("hinge.get reads the authenticated helper's confirmed state", async () => {
  const observed = helper();
  const result = await run("hinge.get");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ device: UDID, hingeAngle: 90 });
  expect(observed.authorization).toEqual([`Bearer ${TOKEN}`]);
});

test("invalid input parameters are refused before connecting", async () => {
  const observed = helper();
  const invalid: Array<[string, Record<string, unknown>]> = [
    ["tap", { x: 0.5, y: -1 }],
    ["gesture", { events: [] }],
    ["gesture", { events: [events[0]] }],
    ["gesture", { events: [...Array.from({ length: 256 }, () => events[0]), events[2]] }],
    ["gesture", { events: [events[1], events[2]] }],
    ["gesture", { events: [events[0], events[1]] }],
    ["gesture", { events: [events[0], events[0], events[2]] }],
    ["gesture", { events: [events[0], ...Array.from({ length: 31 }, () => ({ ...events[1], delayMs: 1000 })), events[2]] }],
    ["hinge.get", { udid: "" }],
  ];
  for (const x of [-0.1, 1.1, NaN, Infinity, "0.5"]) invalid.push(["tap", { x, y: 0.5 }]);
  for (const change of [{ x: -1 }, { y: Infinity }, { type: "tap" }, { edge: 5 }, { edge: 0.5 }, { delayMs: -1 }, { delayMs: 1001 }, { delayMs: 0.5 }]) {
    invalid.push(["gesture", { events: [{ ...events[0], ...change }, events[2]] }]);
  }
  for (const text of ["\0", "🦆", "a".repeat(4097)]) invalid.push(["type", { text }]);
  for (const [action, params] of invalid) {
    const request = run(action, params);
    await expect(request).rejects.toBeInstanceOf(InvalidHostActionError);
    await expect(request).rejects.toThrow(new RegExp(`^${action.replace(".", "\\.")}:`));
  }
  expect(observed.authorization).toEqual([]);
  expect(observed.frames).toEqual([]);
});

for (const [action, params] of [["tap", { x: 0.5, y: 0.5 }], ["gesture", { events }], ["type", { text: "a" }]] as const) {
  test(`${action} reports input-pool refusal`, async () => {
    helper("refuse");
    expect((await run(action, params)).exitCode).not.toBe(0);
  });
}

for (const mode of ["interrupt", "errorAck"] as const) {
  test(`tap reports ${mode} instead of success`, async () => {
    helper(mode);
    expect((await run("tap", { x: 0.25, y: 0.75 })).exitCode).not.toBe(0);
  });

  test(`gesture reports ${mode} instead of success`, async () => {
    const observed = helper(mode);
    expect((await run("gesture", { events })).exitCode).not.toBe(0);
    if (mode === "interrupt") expect(observed.frames).toEqual([
      { tag: 0x03, payload: { type: "begin", x: 0.2, y: 0.4, edge: 1 } },
    ]);
  });
}

test("gesture ignores an early ACK and fails when the helper closes without a final ACK", async () => {
  const observed = helper("earlyAck");
  expect((await run("gesture", { events })).exitCode).not.toBe(0);
  expect(observed.frames.map(frame => frame.tag)).toEqual([0x03, 0x03, 0x03, 0x11]);
  expect(observed.acknowledged()).toBe(false);
});
