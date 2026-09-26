import { describe, expect, spyOn, test } from "bun:test";
import * as hostActions from "../host-actions";

import { EventEmitter } from "events";
import {
  applyCameraActionResult,
  closeCameraFrameStreams,
  MAX_CAMERA_FRAME_BYTES,
  ownsCameraFrameStream,
} from "../camera-frames";
import { createExecWebSocketHandler, parseBinaryCameraFrame } from "../exec-ws";

const UDID = "11111111-2222-3333-4444-555555555555";

function message(udid: string, frame: Buffer, opcode = 1): Buffer {
  const device = Buffer.from(udid, "utf-8");
  return Buffer.concat([Buffer.from([opcode, device.length]), device, frame]);
}

describe("parseBinaryCameraFrame", () => {
  test("splits the device from the frame bytes", () => {
    const frame = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x11]);
    const parsed = parseBinaryCameraFrame(message(UDID, frame));
    expect(parsed?.udid).toBe(UDID);
    expect(parsed?.frame.equals(frame)).toBe(true);
  });

  test("rejects another opcode, so a later binary message cannot land as a frame", () => {
    expect(parseBinaryCameraFrame(message(UDID, Buffer.from([1]), 2))).toBeNull();
  });

  test("rejects a header with no frame after it", () => {
    const device = Buffer.from(UDID, "utf-8");
    expect(
      parseBinaryCameraFrame(Buffer.concat([Buffer.from([1, device.length]), device])),
    ).toBeNull();
  });

  test("rejects a truncated header", () => {
    expect(parseBinaryCameraFrame(Buffer.from([1]))).toBeNull();
    expect(parseBinaryCameraFrame(Buffer.alloc(0))).toBeNull();
  });

  test("rejects an empty or oversized device name", () => {
    expect(parseBinaryCameraFrame(Buffer.from([1, 0, 0xff]))).toBeNull();
    expect(parseBinaryCameraFrame(Buffer.from([1, 200, 0xff]))).toBeNull();
  });

  test("rejects a device name that is not a udid, which is a socket path away from the helper", () => {
    expect(parseBinaryCameraFrame(message("../../etc/passwd", Buffer.from([1])))).toBeNull();
    expect(parseBinaryCameraFrame(message("a b", Buffer.from([1])))).toBeNull();
  });
});


test("rejects oversized camera payloads", () => {
  expect(parseBinaryCameraFrame(message(UDID, Buffer.alloc(MAX_CAMERA_FRAME_BYTES + 1)))).toBeNull();
  expect(parseBinaryCameraFrame(message("DEVICE-A", Buffer.from([1])))).toBeNull();
});

class TestSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string | Buffer): void { this.sent.push(JSON.parse(data.toString())); }
  close(): void { this.readyState = 3; this.emit("close"); }
}

test("only authenticated binary frames reach a socket-owned camera sink", () => {
  const frames: Array<{ udid: string; owner: symbol }> = [];
  const closed: symbol[] = [];
  const handler = createExecWebSocketHandler({
    path: "/exec-ws",
    execToken: "camera-test",
    onCameraFrame: (udid, _frame, owner) => { frames.push({ udid, owner }); return true; },
    onCameraClose: (owner) => closed.push(owner),
  });
  const first = new TestSocket();
  const second = new TestSocket();
  handler(new Request("http://localhost/exec-ws"), first);
  handler(new Request("http://localhost/exec-ws"), second);
  const frame = message(UDID, Buffer.from([1, 2]));
  first.emit("message", frame, true);
  expect(frames).toHaveLength(0);
  for (const socket of [first, second]) {
    socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
    socket.emit("message", message("../bad", Buffer.from([1])), true);
    socket.emit("message", frame, true);
  }
  expect(frames.map((item) => item.udid)).toEqual([UDID, UDID]);
  expect(frames[0]!.owner).not.toBe(frames[1]!.owner);
  first.emit("error", new Error("closed"));
  first.emit("message", frame, true);
  expect(frames).toHaveLength(2);
  expect(closed).toEqual([frames[0]!.owner]);
  second.close();
  expect(closed).toEqual(frames.map((item) => item.owner));
});


test("camera stop requires authentication, an exact header, and preserves socket ownership", () => {
  const stops: Array<{ udid: string; owner: symbol }> = [];
  let frameOwner: symbol | undefined;
  const handler = createExecWebSocketHandler({
    path: "/exec-ws",
    execToken: "camera-test",
    onCameraFrame: (_udid, _frame, owner) => { frameOwner = owner; return true; },
    onCameraStop: (udid, owner) => stops.push({ udid, owner }),
  });
  const socket = new TestSocket();
  handler(new Request("http://localhost/exec-ws"), socket);
  const stop = message(UDID, Buffer.alloc(0), 2);
  socket.emit("message", stop, true);
  expect(stops).toHaveLength(0);
  socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
  socket.emit("message", message(UDID, Buffer.from([1])), true);
  socket.emit("message", message(UDID, Buffer.from([1]), 2), true);
  socket.emit("message", message("../bad", Buffer.alloc(0), 2), true);
  socket.emit("message", stop.subarray(0, stop.length - 1), true);
  expect(stops).toHaveLength(0);
  socket.emit("message", stop, true);
  expect(stops).toHaveLength(1);
  expect(stops[0]!.udid).toBe(UDID);
  if (!frameOwner) throw new Error("frame owner was not recorded");
  expect(stops[0]!.owner).toBe(frameOwner);
  socket.close();
});


test("an action finishing after socket close does not claim the camera", async () => {
  const result = { stdout: "", stderr: "", exitCode: 0 };
  let finish: ((value: typeof result) => void) | undefined;
  const pending = new Promise<typeof result>((resolve) => { finish = resolve; });
  const action = spyOn(hostActions, "runHostActionAsync").mockReturnValue(pending);
  let claimed: symbol | null | undefined;
  let frameOwner: symbol | undefined;
  const socket = new TestSocket();
  try {
    const handler = createExecWebSocketHandler({
      path: "/exec-ws",
      execToken: "camera-test",
      onCameraFrame: (_udid, _frame, owner) => { frameOwner = owner; return true; },
      onActionResult: (_action, _params, _result, owner) => { claimed = owner; },
      onCameraClose: (owner) => { if (claimed === owner) claimed = undefined; },
    });
    handler(new Request("http://localhost/exec-ws"), socket);
    socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
    socket.emit("message", message(UDID, Buffer.from([1])), true);
    socket.emit("message", Buffer.from(JSON.stringify({
      id: 1, action: "camera.inject", params: { udid: UDID, source: "stream" },
    })), false);
    await Bun.sleep(0);
    expect(action).toHaveBeenCalledTimes(1);
    socket.close();
    if (!finish) throw new Error("action completion was not recorded");
    finish(result);
    await Bun.sleep(0);
    expect(frameOwner).toBeDefined();
    expect(claimed).toBeNull();
  } finally {
    socket.close();
    action.mockRestore();
  }
});


for (const closed of [false, true]) {
  test(`logs action callback failures with socket ${closed ? "closed" : "open"}`, async () => {
    const result = { stdout: "", stderr: "", exitCode: 0 };
    const action = spyOn(hostActions, "runHostActionAsync").mockResolvedValue(result);
    const log = spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("camera claim failed");
    let claimed: symbol | null | undefined;
    let closes = 0;
    const socket = new TestSocket();
    try {
      createExecWebSocketHandler({
        path: "/exec-ws",
        execToken: "camera-test",
        onActionResult: (_action, _params, _result, owner) => {
          claimed = owner;
          throw failure;
        },
        onCameraClose: (owner) => {
          closes++;
          if (claimed === owner) claimed = undefined;
        },
      })(new Request("http://localhost/exec-ws"), socket);
      socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
      socket.emit("message", Buffer.from(JSON.stringify({
        id: 1, action: "camera.inject", params: { udid: UDID, source: "stream" },
      })), false);
      if (closed) socket.close();
      await Bun.sleep(0);
      expect(log).toHaveBeenCalledWith("serve-sim action result hook failed:", failure);
      if (closed) {
        expect(claimed).toBeNull();
        expect(closes).toBe(1);
      } else {
        expect(socket.sent.at(-1)).toEqual({ id: 1, ...result });
      }
    } finally {
      socket.close();
      action.mockRestore();
      log.mockRestore();
    }
  });
}


test("ownership loss notifies once, while accepted frames and delivery drops do not notify", async () => {
  const action = spyOn(hostActions, "runHostActionAsync").mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
  const socket = new TestSocket();
  let owns = true;
  try {
    const handler = createExecWebSocketHandler({
      path: "/exec-ws",
      execToken: "camera-test",
      onCameraFrame: () => owns,
    });
    handler(new Request("http://localhost/exec-ws"), socket);
    socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
    const frame = message(UDID, Buffer.from([1]));
    socket.emit("message", frame, true);
    expect(socket.sent.filter((item) => item.cameraStopped)).toHaveLength(0);
    owns = false;
    socket.emit("message", frame, true);
    socket.emit("message", frame, true);
    expect(socket.sent.filter((item) => item.cameraStopped)).toEqual([{ cameraStopped: UDID }]);
    socket.emit("message", Buffer.from(JSON.stringify({
      id: 1, action: "camera.inject", params: { udid: UDID, source: "stream" },
    })), false);
    await Bun.sleep(0);
    socket.emit("message", frame, true);
    expect(socket.sent.filter((item) => item.cameraStopped)).toHaveLength(2);
  } finally {
    socket.close();
    action.mockRestore();
  }
});


test("bounds camera ownership notifications for arbitrary device IDs", () => {
  const socket = new TestSocket();
  createExecWebSocketHandler({
    path: "/exec-ws", execToken: "camera-test", onCameraFrame: () => false,
  })(new Request("http://localhost/exec-ws"), socket);
  socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
  for (let i = 0; i < 65; i++) {
    const device = `${i.toString(16).padStart(8, "0")}-2222-3333-4444-555555555555`;
    socket.emit("message", message(device, Buffer.from([1])), true);
  }
  expect(socket.readyState).toBe(3);
  expect(socket.sent.filter((item) => item.cameraStopped)).toHaveLength(64);
});

test("an older source change completes before a newer viewer claims the stream", async () => {
  const result = { stdout: "", stderr: "", exitCode: 0 };
  let finishOlder: ((value: typeof result) => void) | undefined;
  const olderResult = new Promise<typeof result>((resolve) => { finishOlder = resolve; });
  const action = spyOn(hostActions, "runHostActionAsync")
    .mockReturnValueOnce(olderResult)
    .mockResolvedValueOnce(result);
  let newOwner: symbol | undefined;
  const handler = createExecWebSocketHandler({
    path: "/exec-ws",
    execToken: "camera-test",
    onCameraFrame: (_udid, _frame, owner) => { newOwner = owner; return true; },
    onActionResult: applyCameraActionResult,
    onCameraClose: closeCameraFrameStreams,
  });
  const [older, newer] = [new TestSocket(), new TestSocket()];
  try {
    for (const socket of [older, newer]) {
      handler(new Request("http://localhost/exec-ws"), socket);
      socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
    }
    older.emit("message", Buffer.from(JSON.stringify({
      id: 1, action: "camera.switch", params: { udid: UDID, source: "image" },
    })), false);
    newer.emit("message", Buffer.from(JSON.stringify({
      id: 1, action: "camera.inject", params: { udid: UDID, source: "stream" },
    })), false);
    await Bun.sleep(0);
    expect(action).toHaveBeenCalledTimes(1);
    finishOlder?.(result);
    await Bun.sleep(0);
    expect(action).toHaveBeenCalledTimes(2);
    newer.emit("message", message(UDID, Buffer.from([1])), true);
    if (!newOwner) throw new Error("the newer viewer's owner was not recorded");
    expect(ownsCameraFrameStream(UDID, newOwner)).toBe(true);
  } finally {
    older.close();
    newer.close();
    action.mockRestore();
  }
});

test("a closed viewer's late stream enable leaves a newer viewer's feed alone", async () => {
  const result = { stdout: "", stderr: "", exitCode: 0 };
  let finishFirst: ((value: typeof result) => void) | undefined;
  const first = new Promise<typeof result>((resolve) => { finishFirst = resolve; });
  const action = spyOn(hostActions, "runHostActionAsync")
    .mockReturnValueOnce(first)
    .mockResolvedValueOnce(result);
  let frameOwner: symbol | undefined;
  const handler = createExecWebSocketHandler({
    path: "/exec-ws",
    execToken: "camera-test",
    onCameraFrame: (_udid, _frame, owner) => { frameOwner = owner; return true; },
    onActionResult: applyCameraActionResult,
    onCameraClose: closeCameraFrameStreams,
  });
  const [older, newer] = [new TestSocket(), new TestSocket()];
  try {
    for (const socket of [older, newer]) {
      handler(new Request("http://localhost/exec-ws"), socket);
      socket.emit("message", Buffer.from('{"token":"camera-test"}'), false);
    }
    const enable = JSON.stringify({ id: 1, action: "camera.inject", params: { udid: UDID, source: "stream" } });
    older.emit("message", Buffer.from(enable), false);
    older.close();
    newer.emit("message", Buffer.from(enable), false);
    await Bun.sleep(0);
    expect(action).toHaveBeenCalledTimes(1);
    finishFirst?.(result);
    await Bun.sleep(0);
    expect(action).toHaveBeenCalledTimes(2);
    newer.emit("message", message(UDID, Buffer.from([1])), true);
    if (!frameOwner) throw new Error("the newer viewer's owner was not recorded");
    expect(ownsCameraFrameStream(UDID, frameOwner)).toBe(true);
  } finally {
    older.close();
    newer.close();
    action.mockRestore();
  }
});
