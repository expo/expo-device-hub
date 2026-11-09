import { clearEventLogForTests, readEventLog } from "../../event-log";
import { afterAll, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import * as sessions from "../../device-session";
import * as simctl from "../../simctl";
import * as native from "../../native";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describeHostActions } from "../../host-actions";
import { UDID, useTempStateDir } from "../helpers";
import type { UpgradeHandlerWebSocket } from "../../socket/types";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);
const secondPanelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==",
  "base64",
);
const converted: number[][] = [];
const widths: (number | undefined)[] = [];
let rejectConversion = false;
const jpeg = Buffer.from([255, 216, 255, 217]);
mock.module("../../native", () => ({
  ...native,
  convertScreenshot: async (bytes: Uint8Array, width = 0, quality = 0) => {
    if (rejectConversion) throw new Error("Injected JPEG conversion failure");
    converted.push([width, quality]);
    return quality ? jpeg : bytes;
  },
}));
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
      screenshot: async (display: number, _timeout: number, maxWidth?: number) => {
        widths.push(maxWidth);
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
test("invalid image options are refused before capture", async () => {
  for (const query of [
    "maxWidth=0",
    "maxWidth=1.5",
    "maxWidth=8193",
    "format=gif",
    "quality=101",
  ]) {
    const response = await middleware(
      new Request(`http://localhost/preview/api/screenshot?device=${UDID}&${query}`, {
        method: "POST",
        headers: { authorization: "Bearer test" },
      }),
    );
    expect(response!.status, query).toBe(400);
  }
});
afterAll(async () => {
  await middleware.dispose();
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
    expect(JSON.parse(response!.headers.get("x-expo-screenshot-metadata")!)).toEqual({
      width: 0,
      height: 0,
      displayRotation: null,
      displayId: 0,
      displayCount: 0,
    });
    expect(response!.headers.get("access-control-expose-headers")).toContain(
      "X-Expo-Screenshot-Metadata",
    );
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

test("image options reach native capture and JPEG response for HTTP and binary WS", async () => {
  unstable = false;
  activeDisplay = 7;
  const response = await middleware(
    new Request(
      `http://localhost/preview/api/screenshot?device=${UDID}&maxWidth=402&format=jpeg&quality=65`,
      {
        method: "POST",
        headers: { authorization: "Bearer test" },
      },
    ),
  );
  expect(response!.headers.get("content-type")).toBe("image/jpeg");
  expect(response!.headers.get("content-length")).toBe(String(jpeg.length));
  expect(Buffer.from(await response!.arrayBuffer())).toEqual(jpeg);
  expect(widths.at(-1)).toBe(402);
  expect(converted.at(-1)).toEqual([0, 65]);
  const binary = (await socketRequest({
    udid: UDID,
    maxWidth: 402,
    format: "jpeg",
    quality: 65,
  })) as Buffer;
  expect(binary.subarray(4)).toEqual(jpeg);
  expect(widths.at(-1)).toBe(402);
  expect(converted.at(-1)).toEqual([0, 65]);
  const fallback = await middleware(
    new Request(`http://localhost/preview/api/screenshot?device=${UDID}&display=7&maxWidth=402`, {
      method: "POST",
      headers: { authorization: "Bearer test" },
    }),
  );
  expect(fallback!.status).toBe(200);
  expect(converted.at(-1)).toEqual([402, 0]);
});

test("screenshot catalog keeps the filename as the first positional option", () => {
  const entry = describeHostActions()["screenshot.capture"]!;
  expect(
    Object.keys(entry.properties ?? {})
      .filter((key) => key !== "udid")
      .slice(0, 3),
  ).toEqual(["fileName", "display", "output"]);
});

test("JPEG conversion failure publishes only a failure and no artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jpeg-failure-"));
  const previous = process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
  process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = directory;
  rejectConversion = true;
  try {
    for (const transport of ["http", "binary"]) {
      clearEventLogForTests();
      if (transport === "http") {
        const response = await middleware(
          new Request(`http://localhost/preview/api/screenshot?device=${UDID}&format=jpeg`, {
            method: "POST",
            headers: { authorization: "Bearer test" },
          }),
        );
        expect(response!.status).toBe(500);
      } else {
        expect(await socketRequest({ udid: UDID, format: "jpeg" })).toEqual({
          id: 42,
          error: "Simulator screenshot failed",
        });
      }
      expect(readEventLog().map(({ status, summary }) => ({ status, summary }))).toEqual([
        { status: "error", summary: "Screenshot failed" },
      ]);
      expect(readdirSync(directory)).toEqual([]);
    }
  } finally {
    rejectConversion = false;
    if (previous === undefined) delete process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY;
    else process.env.EXPO_DEVICE_HUB_SCREENSHOT_DIRECTORY = previous;
    rmSync(directory, { recursive: true, force: true });
  }
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

test("HTTP automation preserves manual defaults and suppresses automated artifacts/activity", async () => {
  for (const automation of [undefined, false, true]) {
    for (const failed of [false, true]) {
      unstable = failed;
      reads = 0;
      clearEventLogForTests();
      const before = readdirSync(screenshotDirectory).length;
      const response = await middleware(
        new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
          method: "POST",
          headers: { authorization: "Bearer test", "content-type": "application/json" },
          body: JSON.stringify(automation === undefined ? {} : { automation }),
        }),
      );
      expect(response!.status).toBe(failed ? 500 : 200);
      expect(readdirSync(screenshotDirectory).length - before).toBe(
        !failed && automation !== true ? 1 : 0,
      );
      expect(
        readEventLog({ device: UDID }).filter((event) => event.kind === "screenshot"),
      ).toHaveLength(automation === true ? 0 : 1);
      if (!failed) expect(Buffer.from(await response!.arrayBuffer())).toEqual(png);
    }
  }
});

test("HTTP automation rejects invalid bodies before capture and retains authentication", async () => {
  for (const [body, status] of [
    ["{", 400],
    ['{"automation":"true"}', 400],
    ['{"automation":1}', 400],
    ["null", 400],
    ["[]", 400],
    ['{"extra":true}', 400],
    [" ".repeat(1025), 413],
  ] as const) {
    const before = targets.length;
    const response = await middleware(
      new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body,
      }),
    );
    expect(response!.status).toBe(status);
    expect(targets).toHaveLength(before);
  }
  const before = targets.length;
  const response = await middleware(
    new Request(`http://localhost/preview/api/screenshot?device=${UDID}`, {
      method: "POST",
      body: JSON.stringify({ automation: true }),
    }),
  );
  expect(response!.status).toBe(401);
  expect(targets).toHaveLength(before);
});

test("automation also suppresses artifacts and activity for resized JPEG HTTP and WS captures", async () => {
  unstable = false;
  activeDisplay = 7;
  clearEventLogForTests();
  const before = readdirSync(screenshotDirectory).length;
  const response = await middleware(
    new Request(
      `http://localhost/preview/api/screenshot?device=${UDID}&maxWidth=402&format=jpeg&quality=65`,
      {
        method: "POST",
        headers: { authorization: "Bearer test" },
        body: JSON.stringify({ automation: true }),
      },
    ),
  );
  expect(response!.status).toBe(200);
  expect(response!.headers.get("content-type")).toBe("image/jpeg");
  expect(response!.headers.get("X-Expo-Screenshot-Artifact")).toBe("disabled");
  expect(Buffer.from(await response!.arrayBuffer())).toEqual(jpeg);
  const binary = await socketRequest({
    udid: UDID,
    automation: true,
    maxWidth: 402,
    format: "jpeg",
    quality: 65,
  });
  expect((binary as Buffer).subarray(4)).toEqual(jpeg);
  expect(converted.at(-1)).toEqual([0, 65]);
  expect(widths.at(-1)).toBe(402);
  expect(readdirSync(screenshotDirectory)).toHaveLength(before);
  expect(
    readEventLog({ device: UDID }).filter((event) => event.kind === "screenshot"),
  ).toHaveLength(0);
});
