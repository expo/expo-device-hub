import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as childProcess from "child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { SCREENSHOT_DIR } from "../../host-paths";
import { UDID } from "../helpers";
import * as device from "../../device";

const calls: Array<{ file: string; args: string[] }> = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
const names: string[] = [];
let fail = false;
let displays: number[] = [];
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
  ) => await capture({ activeScreenId: async () => displays.shift() ?? 3 }),
}));
const { runHostActionAsync } = await import("../../host-actions");
beforeEach(() => {
  calls.length = 0;
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

test("catalog advertises optional Desktop-copy and automation fields", async () => {
  const result = await runHostActionAsync({ action: "actions.describe", params: {} }, "true");
  const schema = JSON.parse(result.stdout)["screenshot.capture"];
  expect(schema.properties.copyToDesktop).toMatchObject({ type: "boolean", default: true });
  expect(schema.properties.automation).toMatchObject({ type: "boolean", default: false });
  expect(schema.required).not.toContain("copyToDesktop");
  expect(schema.required).not.toContain("automation");
});

test("omitted or true copyToDesktop preserves the manual Desktop copy", async () => {
  for (const extra of [{}, { copyToDesktop: true }, { automation: true }]) {
    calls.length = 0;
    const result = await capture(extra);
    expect(result.exitCode).toBe(0);
    expect(calls.filter((call) => call.file === "cp")).toHaveLength(1);
    expect(readFileSync(result.stdout)).toEqual(png);
  }
});

test("false skips Desktop copying while preserving active-panel capture and staged PNG", async () => {
  displays = [1, 3, 3];
  const result = await capture({ copyToDesktop: false, automation: true });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(readFileSync(result.stdout)).toEqual(png);
  expect(calls.map((call) => call.file)).toEqual(["xcrun", "xcrun"]);
  expect(calls.map((call) => call.args.find((arg) => arg.startsWith("--display=")))).toEqual([
    "--display=1",
    "--display=3",
  ]);
});

test("failed background captures do not copy or leave an empty reservation", async () => {
  fail = true;
  expect((await capture({ copyToDesktop: false })).exitCode).toBe(1);
  expect(calls.some((call) => call.file === "cp")).toBe(false);
  expect(existsSync(join(SCREENSHOT_DIR, names.at(-1)!))).toBe(false);
});

test("invalid boolean flags are refused before capture", async () => {
  for (const extra of [{ copyToDesktop: "false" }, { automation: "true" }, { automation: 1 }]) {
    await expect(capture(extra)).rejects.toThrow();
  }
  expect(calls).toEqual([]);
});
