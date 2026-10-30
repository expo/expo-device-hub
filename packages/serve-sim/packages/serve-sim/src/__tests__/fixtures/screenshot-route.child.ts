import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import * as sessions from "../../device-session";
import { writeFileSync } from "fs";
import { UDID, useTempStateDir } from "../helpers";
import type { UpgradeHandlerWebSocket } from "../../socket/types";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
let unstable = false,
  reads = 0,
  fallbackReads = 0,
  simctlCaptures = 0;
const targets: string[] = [];
mock.module("../../device-session", () => ({
  ...sessions,
  withScreenshotDeviceSession: async (
    device: string,
    _settings: unknown,
    capture: (session: unknown) => Promise<unknown>,
  ) => {
    targets.push(device);
    return await capture({
      activeScreenId: async () => (unstable ? (++reads % 2 ? 7 : 8) : 7),
      screenshot: async () => png,
    });
  },
}));
mock.module("../../screenshot-display", () => ({
  getScreenshotDisplayIdsAsync: async () => {
    fallbackReads++;
    return [7];
  },
}));
mock.module("child_process", () => ({
  ...childProcess,
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    done: (error: unknown, stdout: string, stderr: string) => void,
  ) => {
    if (args.includes("screenshot")) {
      simctlCaptures++;
      writeFileSync(args.at(-1)!, png);
      queueMicrotask(() => done(null, "", ""));
    } else
      queueMicrotask(() =>
        done(
          null,
          JSON.stringify({
            devices: { runtime: [{ udid: UDID, state: "Booted", name: "Test phone" }] },
          }),
          "",
        ),
      );
    return {};
  },
}));
const temp = useTempStateDir();
const { simMiddleware } = await import("../../middleware");
const middleware = simMiddleware({ basePath: "/preview", execToken: "test", device: UDID });
afterAll(async () => {
  await middleware.dispose();
  temp.restore();
});

function socketRequest(payload: unknown): Promise<Buffer | { id: number; error: string }> {
  const handleWebSocket = middleware.handleWebSocket;
  if (!handleWebSocket) throw new Error("Middleware must expose its WebSocket handler");
  return new Promise((resolve, reject) => {
    let receive!: (data: Buffer) => void;
    const timeout = setTimeout(() => reject(Error("No socket reply")), 3000);
    const ws = {
      OPEN: 1,
      readyState: 1,
      close() {},
      on(event: string, listener: typeof receive) {
        if (event === "message") receive = listener;
      },
      send(data: string | Buffer) {
        if (typeof data === "string" && JSON.parse(data).ready) return;
        clearTimeout(timeout);
        resolve(Buffer.isBuffer(data) ? data : JSON.parse(data));
      },
    } as UpgradeHandlerWebSocket;
    void Promise.resolve(
      handleWebSocket(
        new Request("http://localhost/preview/exec-ws", {
          headers: {
            host: "localhost",
            authorization: "Bearer test",
            "sec-websocket-protocol": "serve-sim.token.test",
          },
        }),
        ws,
      ),
    )
      .then(() => {
        receive(Buffer.from(JSON.stringify({ id: 42, screenshot: payload })));
      })
      .catch(reject);
  });
}

test("real socket callback returns HTTP PNG bytes and validates device/display input", async () => {
  const response = await middleware(
    new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
    }),
  );
  expect(response!.headers.get("content-length")).toBe(String(png.length));
  const http = Buffer.from(await response!.arrayBuffer());
  const binary = (await socketRequest({ device: UDID })) as Buffer;
  expect(binary.readUInt32BE()).toBe(42);
  expect(binary.subarray(4)).toEqual(http);
  expect(targets).toEqual([UDID, UDID]);
  expect(await socketRequest({ device: "invalid" })).toEqual({
    id: 42,
    error: "Invalid simulator device ID",
  });
  expect(await socketRequest({ device: UDID, display: 0 })).toEqual({
    id: 42,
    error: "Invalid screenshot request",
  });
  expect(simctlCaptures).toBe(0);
});

test("unstable single-panel capture returns retry guidance without consulting fallback", async () => {
  unstable = true;
  reads = 0;
  fallbackReads = 0;
  simctlCaptures = 0;
  const response = await middleware(
    new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
    }),
  );
  expect(response!.status).toBe(500);
  expect((await response!.json()).error).toContain("active display kept changing");
  expect(reads).toBe(4);
  expect(fallbackReads).toBe(0);
  expect(simctlCaptures).toBe(0);
  reads = 0;
  expect(await socketRequest({ device: UDID })).toEqual({
    id: 42,
    error: "The active display kept changing. Retry the screenshot once the fold has finished.",
  });
  expect(simctlCaptures).toBe(0);
});
