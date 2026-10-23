import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as fsPromises from "fs/promises";
import { UDID, installShims } from "../helpers";

let active = 1;
let unavailable = false;
let startupFailure = false;
let renameFailure = false;
const originalRename = fsPromises.rename;
mock.module("fs/promises", () => ({
  ...fsPromises,
  rename: async (from: string, to: string) => {
    if (renameFailure) throw new Error("EACCES /private/tmp/staging/file.png");
    return await originalRename(from, to);
  },
}));
let sequence: Array<number | Error> = [];
const owners: unknown[][] = [];
mock.module("../../screenshot-display", () => ({
  getScreenshotDisplayIdsAsync: async () => {
    const { devices = {} } = JSON.parse(process.env.SERVE_SIM_TEST_DEVICES_JSON ?? "{}") as {
      devices?: Record<string, Array<{ udid: string; deviceTypeIdentifier?: string }>>;
    };
    const device = Object.values(devices)
      .flat()
      .find((device) => device.udid === UDID);
    return device?.deviceTypeIdentifier === "fixture.single"
      ? [7]
      : device?.deviceTypeIdentifier === "fixture.duo"
        ? [1, 3]
        : null;
  },
}));
beforeEach(() => {
  unavailable = false;
  startupFailure = false;
  renameFailure = false;
  sequence = [];
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: {
      iOS: [{ udid: UDID, name: "QA Duo", state: "Booted", deviceTypeIdentifier: "fixture.duo" }],
    },
  });
});
mock.module("../../device-session", () => ({
  withScreenshotDeviceSession: (
    udid: string,
    settings: unknown,
    capture: (session: unknown) => unknown,
  ) => {
    if (startupFailure) throw new Error("Missing addon /opt/build/native/serve-sim-native.node");
    const args = [udid, settings];
    owners.push(args);
    return capture({
      activeScreenId: async () => {
        if (unavailable) throw new Error("Simulator did not report its active display");
        const value = sequence.shift();
        if (value instanceof Error) throw value;
        return value ?? active;
      },
    });
  },
}));
const { runHostActionAsync } = await import("../../host-actions");
const shims = installShims({
  xcrun:
    '#!/bin/sh\nif [ "$2" = list ]; then printf \'%s\' "$SERVE_SIM_TEST_DEVICES_JSON"; exit 0; fi\nprintf \'%s\\n\' "$@" > "$SERVE_SIM_DISPLAY_ARGV"\nprintf \'PNG:%s\' "$5" > "$6"\n',
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
const settings = {
  transport: "webrtc" as const,
  codec: "h264" as const,
  h264Bitrate: 2_300_000,
  h264Fps: 24,
  maxDimension: 720,
};
async function capture(extra = {}) {
  const fileName = `serve-sim-screenshot-display-test-${names.length}.png`;
  names.push(fileName);
  return runHostActionAsync(
    { action: "screenshot.capture", params: { udid: UDID, fileName, ...extra } },
    "true",
    settings,
  );
}
function displayArg() {
  return readFileSync(log, "utf8")
    .split("\n")
    .find((arg) => arg.startsWith("--display="));
}

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
  expect(await capture()).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("display kept changing"),
  });
  expect(sequence).toEqual([]);
  expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
});

test("a failed recapture preserves the previously validated screenshot of the same name", async () => {
  active = 1;
  expect((await capture()).exitCode).toBe(0);
  const fileName = names.at(-1)!;
  const staged = join(tmpdir(), "serve-sim-screenshots", fileName);
  const previous = readFileSync(staged, "utf8");
  sequence = [3, 1, 3, 1];
  expect((await capture({ fileName })).exitCode).toBe(1);
  expect(readFileSync(staged, "utf8")).toBe(previous);
});

test("removes unconfirmed pixels and the reservation when the post-capture query fails", async () => {
  sequence = [1, new Error("Post-capture display query failed")];
  expect(await capture()).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Could not determine the active display"),
  });
  expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
});

test("publication failure removes an empty reservation and keeps existing validated pixels", async () => {
  active = 1;
  expect((await capture()).exitCode).toBe(0);
  const existingName = names.at(-1)!;
  const directory = join(tmpdir(), "serve-sim-screenshots");
  const existingPath = join(directory, existingName);
  const previous = readFileSync(existingPath, "utf8");
  const before = readdirSync(directory).filter((name) => name.startsWith(".capture-"));
  const noOutput = installShims({ xcrun: "#!/bin/sh\nexit 0\n" });
  try {
    const failed = await capture();
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toBe(
      "Could not capture the screenshot. Check the host logs for details.",
    );
    expect(existsSync(join(directory, names.at(-1)!))).toBe(false);
    const replaced = await capture({ fileName: existingName });
    expect(replaced.exitCode).toBe(1);
    expect(readFileSync(existingPath, "utf8")).toBe(previous);
    expect(readdirSync(directory).filter((name) => name.startsWith(".capture-"))).toEqual(before);
  } finally {
    noOutput.restore();
  }
});

test("keeps the simctl failure and skips a second display query", async () => {
  const failing = installShims({ xcrun: "#!/bin/sh\necho 'capture failed' >&2\nexit 1\n" });
  sequence = [1, new Error("Must not query after simctl failed")];
  try {
    expect(await capture()).toMatchObject({ exitCode: 1, stderr: "capture failed\n" });
    expect(sequence).toHaveLength(1);
    expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
  } finally {
    sequence = [];
    failing.restore();
  }
});

test("canonicalizes native session identity for names, booted, and lowercase UUIDs", async () => {
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: { iOS: [{ udid: UDID, name: "QA Duo", state: "Booted" }] },
  });
  for (const udid of ["qa duo", "booted", UDID.toLowerCase()]) {
    expect((await capture({ udid })).exitCode).toBe(0);
    expect(owners.at(-1)?.[0]).toBe(UDID);
    expect(readFileSync(log, "utf8")).toContain(UDID);
  }
});

test("refuses ambiguous and missing names before starting native capture", async () => {
  const before = owners.length;
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: {
      iOS: [
        { udid: UDID, name: "QA Duo", state: "Booted" },
        { udid: "00000000-0000-0000-0000-000000000001", name: "QA Duo", state: "Booted" },
      ],
    },
  });
  expect(await capture({ udid: "QA Duo" })).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Could not resolve"),
  });
  expect(await capture({ udid: "missing" })).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Could not resolve"),
  });
  expect(owners.length).toBe(before);
});

test("does not silently capture another display when active selection fails", async () => {
  unavailable = true;
  expect(await capture()).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Could not determine the active display"),
    stdout: "",
  });
});

test("uses the sole integrated panel when native selection is unavailable", async () => {
  unavailable = true;
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: { iOS: [{ udid: UDID, state: "Booted", deviceTypeIdentifier: "fixture.single" }] },
  });
  expect((await capture()).exitCode).toBe(0);
  expect(displayArg()).toBe("--display=7");
});

test("does not fallback for unknown profiles", async () => {
  unavailable = true;
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({ devices: { iOS: [] } });
  expect((await capture()).exitCode).toBe(1);
});

test("rejects known non-integrated ports before invoking screenshot", async () => {
  rmSync(log, { force: true });
  expect(await capture({ display: 2 })).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("device screen"),
  });
  expect(existsSync(log)).toBe(false);
});

test("keeps native search paths in host logs, not client errors", async () => {
  const detail = "Addon missing at /private/tmp/review-build/dist/native/serve-sim-native.node";
  sequence = [new Error(detail)];
  const original = console.error;
  const diagnostics: string[] = [];
  console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
  try {
    const result = await capture();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("/private/tmp");
    expect(result.stderr).not.toContain("serve-sim-native.node");
    expect(diagnostics.join("\n")).toContain(detail);
  } finally {
    console.error = original;
  }
});

test("single-panel fallback also handles native startup failure", async () => {
  startupFailure = true;
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: { iOS: [{ udid: UDID, state: "Booted", deviceTypeIdentifier: "fixture.single" }] },
  });
  expect((await capture()).exitCode).toBe(0);
  expect(displayArg()).toBe("--display=7");
});

test("never falls back after pixels were captured but validation failed", async () => {
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({
    devices: { iOS: [{ udid: UDID, state: "Booted", deviceTypeIdentifier: "fixture.single" }] },
  });
  sequence = [7, new Error("post-read failure")];
  const result = await capture();
  expect(result.exitCode).toBe(1);
  expect(existsSync(join(tmpdir(), "serve-sim-screenshots", names.at(-1)!))).toBe(false);
});

test("explicit capture stays available for unknown profiles", async () => {
  process.env.SERVE_SIM_TEST_DEVICES_JSON = JSON.stringify({ devices: { iOS: [] } });
  expect((await capture({ display: 9 })).exitCode).toBe(0);
  expect(displayArg()).toBe("--display=9");
});

test("publication failures report capture failure rather than an active-panel problem", async () => {
  renameFailure = true;
  expect(await capture()).toMatchObject({
    exitCode: 1,
    stderr: "Could not capture the screenshot. Check the host logs for details.",
  });
});

test("native startup failures report startup rather than a fold problem", async () => {
  startupFailure = true;
  expect(await capture()).toMatchObject({
    exitCode: 1,
    stderr: expect.stringContaining("Could not start screenshot capture"),
  });
});
