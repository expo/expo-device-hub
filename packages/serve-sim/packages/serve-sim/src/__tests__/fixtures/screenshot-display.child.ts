import { afterAll, expect, mock, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UDID, installShims } from "../helpers";

let active = 1;
let unavailable = false;
let sequence: number[] = [];
const owners: unknown[][] = [];
mock.module("../../device-session", () => ({
  getDeviceSession: (...args: unknown[]) => {
    owners.push(args);
    return { activeScreenId: async () => {
      if (unavailable) throw new Error("Simulator did not report its active display");
      return sequence.shift() ?? active;
    } };
  },
}));
const { runHostActionAsync } = await import("../../host-actions");
const shims = installShims({
  xcrun: "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$SERVE_SIM_DISPLAY_ARGV\"\n",
  cp: "#!/bin/sh\nexit 0\n",
});
const log = join(shims.dir, "argv");
process.env.SERVE_SIM_DISPLAY_ARGV = log;
const names: string[] = [];
afterAll(() => {
  for (const name of names) rmSync(join(tmpdir(), "serve-sim-screenshots", name), { force: true });
  delete process.env.SERVE_SIM_DISPLAY_ARGV;
  shims.restore();
});
const settings = { transport: "webrtc" as const, codec: "h264" as const, h264Bitrate: 2_300_000, h264Fps: 24, maxDimension: 720 };
async function capture(extra = {}) {
  const fileName = `serve-sim-screenshot-display-test-${names.length}.png`;
  names.push(fileName);
  return runHostActionAsync({ action: "screenshot.capture", params: { udid: UDID, fileName, ...extra } }, "true", settings);
}
function displayArg() { return readFileSync(log, "utf8").split("\n").find((arg) => arg.startsWith("--display=")); }

test("follows external active-panel changes and preserves middleware settings", async () => {
  for (const id of [1, 3, 1]) {
    active = id;
    expect((await capture()).exitCode).toBe(0);
    expect(displayArg()).toBe(`--display=${id}`);
    expect(owners.at(-1)).toEqual([UDID, settings]);
  }
});

test("captures an explicit inactive display without starting an active feed", async () => {
  const before = owners.length;
  active = 1;
  expect((await capture({ display: 3 })).exitCode).toBe(0);
  expect(displayArg()).toBe("--display=3");
  expect(owners.length).toBe(before);
});

test("refuses invalid display IDs", async () => {
  for (const display of [0, -1, 1.5, "3", 4294967296]) {
    await expect(capture({ display })).rejects.toThrow();
  }
});

test("recaptures when the active display changes while simctl takes the screenshot", async () => {
  active = 3;
  sequence = [1, 3, 3];
  expect((await capture()).exitCode).toBe(0);
  expect(sequence).toEqual([]);
  expect(displayArg()).toBe("--display=3");
});

test("bounds retries if the active display keeps changing", async () => {
  sequence = [1, 3, 1, 3];
  expect(await capture()).toMatchObject({ exitCode: 1, stderr: expect.stringContaining("display kept changing") });
  expect(sequence).toEqual([]);
});

test("does not silently capture another display when active selection fails", async () => {
  unavailable = true;
  expect(await capture()).toMatchObject({ exitCode: 1, stderr: "Simulator did not report its active display", stdout: "" });
});
