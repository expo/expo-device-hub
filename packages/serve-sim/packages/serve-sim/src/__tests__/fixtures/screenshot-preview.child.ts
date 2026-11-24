import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { SCREENSHOT_DIR } from "../../host-paths";
import { UDID } from "../helpers";
import * as device from "../../device";

const calls: Array<{ file: string; args: string[] }> = [];
const png = readFileSync(
  new URL("../../../Sources/SimPasteboard/Icons/AppIcon60x60@2x.png", import.meta.url),
);
const names: string[] = [];
let fail = false;
let displays: number[] = [];
const capturedDisplays: number[] = [];
mock.module("child_process", () => ({
  ...childProcess,
  execFile: (
    file: string,
    args: string[],
    _options: unknown,
    done: (...args: unknown[]) => void,
  ) => {
    calls.push({ file, args });
    queueMicrotask(() => {
      if (file === "cp") return done(null, "", "");
      expect(file).toBe("xcrun");
      if (fail) return done(Object.assign(new Error("capture failed"), { code: 1 }), "", "failed");
      writeFileSync(args.at(-1)!, png);
      done(null, "", "");
    });
    return {};
  },
}));
mock.module("../../device", () => ({ ...device, resolveBootedDeviceAsync: async () => UDID }));
mock.module("../../screenshot-display", () => ({
  getScreenshotDisplayIdsAsync: async () => [1, 3],
}));
mock.module("../../device-session", () => ({
  withScreenshotDeviceSession: async (
    _udid: string,
    _settings: unknown,
    capture: (session: unknown) => unknown,
  ) =>
    await capture({
      activeScreenId: async () => displays.shift() ?? 3,
      async screenshotWithMetadata(
        this: { screenshot(display: number): Promise<Uint8Array> },
        display: number,
      ) {
        return {
          data: await this.screenshot(display),
          metadata: {
            width: 120,
            height: 120,
            displayRotation: "portrait",
            screen: display === 3 ? "inner" : "outer",
          },
        };
      },
      screenshot: async (display: number) => {
        capturedDisplays.push(display);
        if (fail) throw new Error("capture failed");
        return png;
      },
    }),
}));
const { runHostActionAsync } = await import("../../host-actions");
beforeEach(() => {
  calls.length = 0;
  capturedDisplays.length = 0;
  fail = false;
  displays = [];
});
afterAll(() => {
  for (const name of names) rmSync(join(SCREENSHOT_DIR, name), { force: true });
});
async function capture(extra = {}) {
  const fileName = `serve-sim-screenshot-preview-test-${names.length}.png`;
  names.push(fileName);
  return await runHostActionAsync(
    { action: "screenshot.capture", params: { udid: UDID, fileName, ...extra } },
    "true",
  );
}

test("catalog advertises the optional automation field", async () => {
  const result = await runHostActionAsync({ action: "actions.describe", params: {} }, "true");
  const schema = JSON.parse(result.stdout)["screenshot.capture"];
  expect(schema.properties.automation).toMatchObject({ type: "boolean", default: false });
  expect(schema.required).not.toContain("automation");
});

test("only manual captures make a Desktop copy", async () => {
  for (const extra of [{}, { automation: false }, { automation: true }]) {
    calls.length = 0;
    const result = await capture(extra);
    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call.file === "cp")).toHaveLength(
      extra.automation === true ? 0 : 1,
    );
    expect(readFileSync(result.stdout)).toEqual(png);
    expect(result.metadata).toEqual({
      width: 120,
      height: 120,
      displayRotation: "portrait",
      screen: "inner",
    });
  }
});

test("automated captures preserve active-panel selection and staged PNG", async () => {
  displays = [1, 3, 3];
  const result = await capture({ automation: true });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(readFileSync(result.stdout)).toEqual(png);
  expect(calls.map((call) => call.file)).toEqual([]);
  expect(capturedDisplays).toEqual([1, 3]);
  expect(result.metadata).toEqual({
    width: 120,
    height: 120,
    displayRotation: "portrait",
    screen: "inner",
  });
});

test("failed background captures do not copy or leave an empty reservation", async () => {
  fail = true;
  expect((await capture({ automation: true })).exitCode).toBe(1);
  expect(calls.some((call) => call.file === "cp")).toBe(false);
  expect(existsSync(join(SCREENSHOT_DIR, names.at(-1)!))).toBe(false);
});

test("invalid boolean flags are refused before capture", async () => {
  for (const extra of [{ automation: "true" }, { automation: 1 }]) {
    await expect(capture(extra)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});

test("authenticated exec-ws path replies carry dimensions beside the unchanged path", async () => {
  const { createExecWebSocketHandler } = await import("../../socket/server-control");
  let receive!: (data: Buffer) => void;
  const sent: string[] = [];
  const pending = new Set<Promise<unknown>>();
  const ws = {
    OPEN: 1,
    readyState: 1,
    send(data: string) {
      sent.push(data);
    },
    close() {},
    on(event: string, callback: typeof receive) {
      if (event === "message") receive = callback;
    },
  } as import("../../socket/types").UpgradeHandlerWebSocket;
  createExecWebSocketHandler({ path: "/exec-ws", execToken: "test", pendingActions: pending })(
    new Request("http://localhost/exec-ws", {
      headers: { "sec-websocket-protocol": "serve-sim.token.test" },
    }),
    ws,
  );
  const fileName = `serve-sim-screenshot-preview-test-${names.length}.png`;
  names.push(fileName);
  receive(
    Buffer.from(
      JSON.stringify({
        id: 7,
        action: "screenshot.capture",
        params: { udid: UDID, fileName, automation: true },
      }),
    ),
  );
  await Promise.all(pending);
  expect(JSON.parse(sent.at(-1)!)).toEqual({
    id: 7,
    stdout: join(SCREENSHOT_DIR, fileName),
    stderr: "",
    exitCode: 0,
    metadata: {
      width: 120,
      height: 120,
      displayRotation: "portrait",
      screen: "inner",
    },
  });
});
