import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLaunchState } from "../launch-state";
import { deviceSessionPid } from "../time-zone-capability";

const UDID = "0F4E3A48-8F26-4A5D-9C7A-1B2C3D4E5F60";
let directory = "";
const previous = process.env.SERVE_SIM_STATE_DIR;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "time-zone-owner-"));
  process.env.SERVE_SIM_STATE_DIR = directory;
});

afterEach(() => {
  if (previous === undefined) delete process.env.SERVE_SIM_STATE_DIR;
  else process.env.SERVE_SIM_STATE_DIR = previous;
  rmSync(directory, { recursive: true, force: true });
});

const EXITED = 2147483647;

function capability(ownerPid: number | null) {
  return {
    name: "clipboard",
    dylib: "/x.dylib",
    scope: "allApps" as const,
    bundleId: null,
    ownerPid,
  };
}

test("a live session or capability owner owns it", () => {
  writeLaunchState(UDID, { sessionPids: [EXITED, process.pid], launchArgs: [], capabilities: {} });
  expect(deviceSessionPid(UDID)).toBe(process.pid);
  writeLaunchState(UDID, { launchArgs: [], capabilities: { clipboard: capability(process.pid) } });
  expect(deviceSessionPid(UDID)).toBe(process.pid);
});

test("no state, exited owners or persistent records leave it unowned", () => {
  expect(deviceSessionPid(UDID)).toBeNull();
  writeLaunchState(UDID, {
    sessionPids: [EXITED],
    launchArgs: [],
    capabilities: {
      clipboard: capability(EXITED),
      camera: { ...capability(null), name: "camera" },
    },
  });
  expect(deviceSessionPid(UDID)).toBeNull();
});
