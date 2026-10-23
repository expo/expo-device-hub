import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installShims } from "../helpers";

const root = mkdtempSync(join(tmpdir(), "serve-sim-display-profiles-"));
const profiles = [
  [
    "Single",
    [
      { displayType: "integrated", screenID: 7 },
      { displayType: "tvOut", screenID: 2 },
    ],
    [7],
  ],
  [
    "Duo",
    [
      { displayType: "integrated", screenID: 1 },
      { displayType: "integrated", screenID: 3 },
    ],
    [1, 3],
  ],
  ["TV", [{ displayType: "tvOut", screenID: 1 }], [1]],
  [
    "ExternalOnly",
    [
      { displayType: "tvOut", screenID: 1 },
      { displayType: "carPlay", screenID: 2 },
    ],
    null,
  ],
  ["Empty", [], null],
  ["Malformed", [{ displayType: "integrated", screenID: 1 }, {}], null],
  ["Missing", undefined, null],
  ["BadID", [{ displayType: "integrated", screenID: "1" }], null],
  [
    "Duplicate",
    [
      { displayType: "integrated", screenID: 1 },
      { displayType: "integrated", screenID: 1 },
    ],
    null,
  ],
  ["Slow", [{ displayType: "integrated", screenID: 1 }], [1]],
] as const;
const devices: Array<{ udid: string; deviceTypeIdentifier: string }> = [];
const devicetypes: Array<{ identifier: string; bundlePath: string }> = [];
for (const [i, [name, displays]] of profiles.entries()) {
  const bundlePath = join(root, `${name}.simdevicetype`);
  const resources = join(bundlePath, "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  if (displays !== undefined)
    writeFileSync(
      join(resources, "capabilities.plist"),
      JSON.stringify({ capabilities: { displays } }),
    );
  devices.push({
    udid: `AAAAAAAA-BBBB-CCCC-DDDD-${i.toString(16).padStart(12, "0").toUpperCase()}`,
    deviceTypeIdentifier: `fixture.${name}`,
  });
  devicetypes.push({ identifier: `fixture.${name}`, bundlePath });
}
const log = join(root, "plutil.log");
process.env.SERVE_SIM_PROFILE_SNAPSHOT = JSON.stringify({ devices: { iOS: devices }, devicetypes });
process.env.SERVE_SIM_PROFILE_ROOT = root;
process.env.SERVE_SIM_PROFILE_LOG = log;
const shims = installShims({
  xcrun:
    '#!/bin/sh\nif [ "$1" = simctl ] && [ "$2" = list ]; then printf \'%s\' "$SERVE_SIM_PROFILE_SNAPSHOT"; else exit 1; fi\n',
  // JSON fixture files stand in for plist conversion on every platform. The real
  // identifier lookup, asynchronous subprocess, path selection and parsing run.
  plutil:
    '#!/bin/sh\ncase "$5" in "$SERVE_SIM_PROFILE_ROOT"/*) ;; *) exit 1;; esac\nprintf \'%s\\n\' "$5" >> "$SERVE_SIM_PROFILE_LOG"\ncase "$5" in *Slow.simdevicetype*) sleep 0.06;; esac\nexec cat "$5"\n',
});
afterAll(() => {
  shims.restore();
  rmSync(root, { recursive: true, force: true });
  delete process.env.SERVE_SIM_PROFILE_SNAPSHOT;
  delete process.env.SERVE_SIM_PROFILE_ROOT;
  delete process.env.SERVE_SIM_PROFILE_LOG;
});
const { getScreenshotDisplayIdsAsync } = await import("../../screenshot-display");

for (const [i, [name, , expected]] of profiles.entries()) {
  test(`${name} screenshot display IDs: ${expected}`, async () => {
    expect(await getScreenshotDisplayIdsAsync(devices[i]!.udid)).toEqual(
      expected ? [...expected] : null,
    );
  });
}
test("reads only the selected bundle without blocking the event loop", async () => {
  const before = readFileSync(log, "utf8").trim().split("\n").length;
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  try {
    expect(await getScreenshotDisplayIdsAsync(devices.at(-1)!.udid.toLowerCase())).toEqual([1]);
    expect(ticked).toBe(true);
    const added = readFileSync(log, "utf8").trim().split("\n").slice(before);
    expect(added).toEqual([
      join(root, "Slow.simdevicetype", "Contents", "Resources", "capabilities.plist"),
    ]);
  } finally {
    clearTimeout(timer);
  }
});
test("unknown device identifiers cannot permit fallback", async () => {
  expect(await getScreenshotDisplayIdsAsync("unknown")).toBeNull();
});
