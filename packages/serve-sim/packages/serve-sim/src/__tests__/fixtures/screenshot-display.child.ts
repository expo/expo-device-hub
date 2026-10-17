import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UDID, installShims } from "../helpers";

let active = 1;
let unavailable = false;
let sequence: Array<number | Error> = [];
const owners: unknown[][] = [];
mock.module("../../device-session", () => ({
  getDeviceSession: (...args: unknown[]) => {
    owners.push(args);
    return { activeScreenId: async () => {
      if (unavailable) throw new Error("Simulator did not report its active display");
      const value = sequence.shift();
      if (value instanceof Error) throw value;
      return value ?? active;
    } };
  },
}));
const { runHostActionAsync } = await import("../../host-actions");
const shims = installShims({
  xcrun: "#!/bin/sh\nif [ \"$2\" = list ]; then printf '%s' \"$SERVE_SIM_TEST_DEVICES_JSON\"; exit 0; fi\nprintf '%s\\n' \"$@\" > \"$SERVE_SIM_DISPLAY_ARGV\"\n",
  cp: "#!/bin/sh\nexit 0\n",
});
const log = join(shims.dir, "argv");
process.env.SERVE_SIM_DISPLAY_ARGV = log;
const names: string[] = [];
afterAll(() => {
  for (const name of names) rmSync(join(tmpdir(), "serve-sim-screenshots", name), { force: true });
  delete process.env.SERVE_SIM_DISPLAY_ARGV;
  delete process.env.SERVE_SIM_TEST_DEVICES_JSON;
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

test("releases an empty reservation when the post-capture display query fails", async () => {
  sequence = [1, new Error("Post-capture display query failed")];
  expect(await capture()).toMatchObject({ exitCode: 1, stderr: "Post-capture display query failed" });
  expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
});

test("keeps the simctl failure and skips a second display query", async () => {
  const failing = installShims({ xcrun: "#!/bin/sh\necho 'capture failed' >&2\nexit 1\n" });
  sequence = [1, new Error("Must not query after simctl failed")];
  try {
    expect(await capture()).toMatchObject({ exitCode: 1, stderr: "capture failed\n" });
    expect(sequence).toHaveLength(1);
    expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
  } finally { sequence = []; failing.restore(); }
});

test("canonicalizes native session identity for names, booted, and lowercase UUIDs", async () => {
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({devices:{iOS:[{udid:UDID,name:"QA Duo",state:"Booted"}]}});
  for (const udid of ["qa duo", "booted", UDID.toLowerCase()]) {
    expect((await capture({udid})).exitCode).toBe(0);
    expect(owners.at(-1)?.[0]).toBe(UDID);
    expect(readFileSync(log,"utf8")).toContain(UDID);
  }
});

test("refuses ambiguous and missing names before starting native capture", async () => {
  const before = owners.length;
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({devices:{iOS:[
    {udid:UDID,name:"QA Duo",state:"Booted"}, {udid:"00000000-0000-0000-0000-000000000001",name:"QA Duo",state:"Booted"},
  ]}});
  expect(await capture({udid:"QA Duo"})).toMatchObject({exitCode:1,stderr:expect.stringContaining("Several booted")});
  expect(await capture({udid:"missing"})).toMatchObject({exitCode:1,stderr:expect.stringContaining("No booted")});
  expect(owners.length).toBe(before);
});

test("does not silently capture another display when active selection fails", async () => {
  unavailable = true;
  expect(await capture()).toMatchObject({ exitCode: 1, stderr: "Simulator did not report its active display", stdout: "" });
});
