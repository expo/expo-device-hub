import { clearEventLogForTests, readEventLog } from "../../event-log";
import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import * as sessions from "../../device-session";
import * as simctl from "../../simctl";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { UDID, useTempStateDir } from "../helpers";
import { accessCookieName } from "../../session-auth";
import type { UpgradeHandlerWebSocket } from "../../socket/types";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const secondPanelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
  "base64",
);
let activeDisplay = 7;
const capturedDisplays: number[] = [];
let unstable = false,
  reads = 0,
  fallbackReads = 0,
  simctlCaptures = 0;
const targets: string[] = [];
mock.module("../../simctl", () => ({
  ...simctl,
  simctl: async (args: string[]) => {
    expect(args).toEqual(["list", "devices", "booted", "-j"]);
    return JSON.stringify({
      devices: { runtime: [{ udid: UDID, state: "Booted", name: "Test phone" }] },
    });
  },
}));
mock.module("../../device-session", () => ({
  ...sessions,
  withScreenshotDeviceSession: async (
    device: string,
    _settings: unknown,
    capture: (session: unknown) => Promise<unknown>,
  ) => {
    targets.push(device);
    return await capture({
      activeScreenId: async () => (unstable ? (++reads % 2 ? 7 : 8) : activeDisplay),
      screenshot: async (display: number) => {
        capturedDisplays.push(display);
        if (display !== 7 && display !== 8) throw new Error("Unexpected display");
        return display === 7 ? png : secondPanelPng;
      },
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
const screenshotDirectory = mkdtempSync(join(tmpdir(), "automated-screenshot-artifacts-"));
const previousScreenshotDirectory = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = screenshotDirectory;
const { simMiddleware } = await import("../../middleware");
const middleware = simMiddleware({ basePath: "/preview", execToken: "test", device: UDID });
const gatedMiddleware = simMiddleware({
  basePath: "/gated",
  execToken: "test",
  device: UDID,
  requirePreviewToken: true,
});
afterAll(async () => {
  await middleware.dispose();
  await gatedMiddleware.dispose();
  temp.restore();
  rmSync(screenshotDirectory, { recursive: true, force: true });
  if (previousScreenshotDirectory === undefined)
    delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previousScreenshotDirectory;
});

function socketRequest(
  payload: Record<string, unknown>,
): Promise<Buffer | { id: number; error: string }> {
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
        receive(
          Buffer.from(
            JSON.stringify({
              id: 42,
              action: "screenshot.capture",
              params: { output: "binary", ...payload },
            }),
          ),
        );
      })
      .catch(reject);
  });
}

test("real socket callback returns HTTP PNG bytes and validates device/display input", async () => {
  for (const display of [7, 8]) {
    activeDisplay = display;
    const response = await middleware(
      new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
        method: "POST",
        headers: { authorization: "Bearer test" },
      }),
    );
    expect(response!.headers.get("content-length")).toBe(String(png.length));
    const http = Buffer.from(await response!.arrayBuffer());
    const binary = (await socketRequest({ udid: UDID })) as Buffer;
    expect(binary.readUInt32BE()).toBe(42);
    expect(binary.subarray(4)).toEqual(http);
    expect(http).toEqual(display === 7 ? png : secondPanelPng);
  }
  expect(targets).toEqual([UDID, UDID, UDID, UDID]);
  expect(capturedDisplays).toEqual([7, 7, 8, 8]);
  expect(await socketRequest({ udid: "invalid/device" })).toEqual({
    id: 42,
    error: "Invalid screenshot request",
  });
  expect(await socketRequest({ udid: UDID, display: 0 })).toEqual({
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
  expect(await socketRequest({ udid: UDID })).toEqual({
    id: 42,
    error: "The active display kept changing. Retry the screenshot once the fold has finished.",
  });
  expect(simctlCaptures).toBe(0);
});

test("binary mode resolves action device names and rejects path-only filename options", async () => {
  unstable = false;
  activeDisplay = 7;
  const result = (await socketRequest({ udid: "Test phone" })) as Buffer;
  expect(result.subarray(4)).toEqual(png);
  expect(targets.at(-1)).toBe(UDID);
  expect(await socketRequest({ udid: UDID, fileName: "serve-sim-screenshot-test.png" })).toEqual({
    id: 42,
    error: "Invalid screenshot request",
  });
});

test("binary automation preserves manual activity and suppresses success and failure events", async () => {
  for (const automation of [undefined, false, true]) {
    for (const failed of [false, true]) {
      unstable = failed;
      reads = 0;
      activeDisplay = 7;
      clearEventLogForTests();
      const filesBefore = readdirSync(screenshotDirectory).length;
      const result = await socketRequest({
        udid: UDID,
        ...(automation === undefined ? {} : { automation }),
      });
      if (failed) expect(Buffer.isBuffer(result)).toBe(false);
      else expect((result as Buffer).subarray(4)).toEqual(png);
      expect(readdirSync(screenshotDirectory).length - filesBefore).toBe(
        !failed && automation !== true ? 1 : 0,
      );
      const events = readEventLog({ device: UDID }).filter((event) => event.kind === "screenshot");
      expect(events).toHaveLength(automation === true ? 0 : 1);
      if (automation !== true) expect(events[0]!.status).toBe(failed ? "error" : "ok");
    }
  }
  expect(await socketRequest({ udid: UDID, automation: "true" })).toEqual({
    id: 42,
    error: "Invalid screenshot request",
  });
});

function httpScreenshot(
  query: string,
  headers: Record<string, string> = { authorization: "Bearer test" },
  handler = middleware,
  base = "/preview",
) {
  return handler(
    new Request(`http://localhost${base}/api/screenshot?device=${UDID}${query}`, {
      method: "POST",
      headers,
    }),
  ) as Promise<Response>;
}

async function expectNoCapture(request: () => Promise<Response>, status: number, error: string) {
  const capturesBefore = targets.length;
  const filesBefore = readdirSync(screenshotDirectory).length;
  clearEventLogForTests();
  const result = await request();
  expect(result.status).toBe(status);
  expect(await result.json()).toEqual({ ok: false, error });
  expect(targets.length).toBe(capturesBefore);
  expect(readdirSync(screenshotDirectory).length).toBe(filesBefore);
  expect(readEventLog({ device: UDID }).filter((event) => event.kind === "screenshot")).toEqual([]);
}

test("HTTP automation query suppresses activity and artifacts on success and failure", async () => {
  for (const automation of [undefined, "0", "false", "1", "true"]) {
    const automated = automation === "1" || automation === "true";
    for (const failed of [false, true]) {
      unstable = failed;
      reads = 0;
      activeDisplay = 7;
      clearEventLogForTests();
      const filesBefore = readdirSync(screenshotDirectory).length;
      const response = await httpScreenshot(
        automation === undefined ? "" : `&automation=${automation}`,
      );
      expect(response.status).toBe(failed ? 500 : 200);
      // The header lets a client tell a server that honored the option from one that ignored it.
      expect(response.headers.get("x-expo-screenshot-automation")).toBe(
        automated ? "applied" : null,
      );
      if (!failed) {
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(response.headers.get("content-length")).toBe(String(png.length));
        expect(response.headers.get("x-expo-screenshot-artifact")).toBe(
          automated ? "disabled" : "saved",
        );
        expect(response.headers.get("access-control-expose-headers")).toContain(
          "X-Expo-Screenshot-Automation",
        );
        expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      }
      expect(readdirSync(screenshotDirectory).length - filesBefore).toBe(
        !failed && !automated ? 1 : 0,
      );
      const events = readEventLog({ device: UDID }).filter((event) => event.kind === "screenshot");
      expect(events).toHaveLength(automated ? 0 : 1);
      if (!automated) expect(events[0]!.status).toBe(failed ? "error" : "ok");
    }
  }
  unstable = false;
});

test("HTTP automation rejects invalid values before capture", async () => {
  activeDisplay = 7;
  for (const query of [
    "&automation=",
    "&automation=yes",
    "&automation=2",
    "&automation=1&automation=1",
  ]) {
    await expectNoCapture(
      () => httpScreenshot(query),
      400,
      "Invalid automation value. Use true, false, 1 or 0.",
    );
  }
});

test("HTTP automation requires the bearer header, not the cookie or a query token", async () => {
  activeDisplay = 7;
  const error = "Automated screenshots require the session bearer token.";
  const cookie = { cookie: `${accessCookieName("test")}=test` };
  // Ungated preview: the route is open, but automation still needs the token as a header.
  await expectNoCapture(() => httpScreenshot("&automation=1", {}), 401, error);
  await expectNoCapture(
    () => httpScreenshot("&automation=1", { authorization: "Bearer wrong" }),
    401,
    error,
  );
  await expectNoCapture(() => httpScreenshot("&automation=1&token=test", {}), 401, error);
  // Gated preview: the cookie and `?token=` pass the gate but cannot hide activity.
  await expectNoCapture(
    () => httpScreenshot("&automation=true", cookie, gatedMiddleware, "/gated"),
    401,
    error,
  );
  await expectNoCapture(
    () => httpScreenshot("&automation=true&token=test", {}, gatedMiddleware, "/gated"),
    401,
    error,
  );
  // Default captures keep every credential form; explicit false needs no header.
  for (const [query, headers] of [
    ["", cookie],
    ["&token=test", {}],
    ["&automation=false", cookie],
  ] as const) {
    clearEventLogForTests();
    const response = await httpScreenshot(query, headers, gatedMiddleware, "/gated");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-expo-screenshot-automation")).toBeNull();
    expect(readEventLog({ device: UDID }).filter((e) => e.kind === "screenshot")).toHaveLength(1);
  }
  clearEventLogForTests();
  const bearer = await httpScreenshot(
    "&automation=true",
    { authorization: "Bearer test" },
    gatedMiddleware,
    "/gated",
  );
  expect(bearer.status).toBe(200);
  expect(bearer.headers.get("x-expo-screenshot-automation")).toBe("applied");
  expect(Buffer.from(await bearer.arrayBuffer())).toEqual(png);
  expect(readEventLog({ device: UDID }).filter((e) => e.kind === "screenshot")).toEqual([]);
});
