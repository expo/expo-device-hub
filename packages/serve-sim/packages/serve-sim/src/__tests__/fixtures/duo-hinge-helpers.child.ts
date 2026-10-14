import { beforeEach, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServeSimDeviceState } from "../../state";
import type { HingeControlCommand } from "../../hinge-control";

const state = { streamUrl: "http://local.test/stream.mjpeg", wsUrl: "ws://local.test/ws", token: "test-token" } as ServeSimDeviceState;
const commands: HingeControlCommand[] = [];
let angle = 0;
let target: number | undefined;
let reads = 0;
let observedAfter = 3;
let tableMode = false;
let authorization: string | null;

class Socket extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit("open")); }
  send(data: Buffer) {
    const request = JSON.parse(data.subarray(1).toString()) as { requestId: number; command: HingeControlCommand };
    commands.push(request.command);
    if (request.command.control === "angle") target = request.command.value;
    if (request.command.control === "table") {
      expect(angle).toBe(target!);
      tableMode = request.command.value;
    }
    this.emit("message", Buffer.concat([Buffer.from([0x90]), Buffer.from(JSON.stringify({ requestId: request.requestId, ok: true }))]));
  }
  close() { this.emit("close"); }
}
mock.module("ws", () => ({ default: Socket }));
const { restoreHingeState, waitForHingeConfig } = await import("../duo-hinge-helpers");

beforeEach(() => {
  commands.length = 0; angle = 0; target = undefined; reads = 0; observedAfter = 3; tableMode = false; authorization = null;
  globalThis.fetch = (async (_input, init) => {
    reads++;
    authorization = new Headers(init?.headers).get("Authorization");
    if (target !== undefined && reads >= observedAfter) angle = target;
    return Response.json({ width: 2007, height: 2853, hingeAngle: target ?? angle,
      physicalOrientation: "portrait", tableMode,
      observedDeviceState: { hingeAngle: angle, physicalOrientation: "portrait", tableMode },
    });
  }) as typeof fetch;
});

test("restoration waits for the observed angle before enabling Table Mode", async () => {
  await restoreHingeState(state, { hingeAngle: 90, tableMode: true });
  expect(commands).toEqual([{ control: "angle", value: 90 }, { control: "table", value: true }]);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(authorization).toBe("Bearer test-token");
});

test("waiting for native state times out when acknowledgements never become observations", async () => {
  observedAfter = Infinity;
  target = 90;
  await expect(waitForHingeConfig(state, { hingeAngle: 90 }, 50)).rejects.toThrow("hinge did not settle");
  expect(angle).toBe(0);
});

test("a sub-degree restore does not require a new native stream sample", async () => {
  angle = 80;
  observedAfter = Infinity;
  const config = await waitForHingeConfig(state, { hingeAngle: 80.25 }, 50);
  expect(config.hingeAngle).toBe(80);
});
