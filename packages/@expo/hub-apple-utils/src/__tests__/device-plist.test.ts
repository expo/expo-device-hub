import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDevicePlist, readDevicePlist } from "../device-plist";

const PLIST_WITH_DATES = `<?xml version="1.0" encoding="UTF-8"?>
  <plist version="1.0">
    <dict>
      <key>lastUsedAt</key>
      <date>2026-07-16T14:20:05Z</date>
      <key>lastBootedAt</key>
      <date>2026-08-03T21:53:24Z</date>
    </dict>
  </plist>`;

const EXPECTED_DATES = {
  lastUsedAt: Date.parse("2026-07-16T14:20:05Z"),
  lastBootedAt: Date.parse("2026-08-03T21:53:24Z"),
};

describe("parseDevicePlist", () => {
  test("parses last-used and last-booted dates as epoch milliseconds", () => {
    const parsed = parseDevicePlist(PLIST_WITH_DATES);

    expect(parsed).toEqual({
      value: EXPECTED_DATES,
      error: null,
    });
  });

  test("reads the device.plist adjacent to a simulator data directory", async () => {
    const simulatorDirectory = await mkdtemp(join(tmpdir(), "hub-device-plist-"));
    const dataPath = join(simulatorDirectory, "data");

    try {
      await mkdir(dataPath);
      await writeFile(join(simulatorDirectory, "device.plist"), PLIST_WITH_DATES);

      expect(await readDevicePlist(dataPath)).toEqual({
        value: EXPECTED_DATES,
        error: null,
      });
    } finally {
      await rm(simulatorDirectory, { recursive: true, force: true });
    }
  });

  test("returns null timestamps when usage metadata is absent", () => {
    const parsed = parseDevicePlist(`<?xml version="1.0" encoding="UTF-8"?>
      <plist version="1.0">
        <dict>
          <key>name</key>
          <string>Unused simulator</string>
        </dict>
      </plist>`);

    expect(parsed).toEqual({
      value: { lastUsedAt: null, lastBootedAt: null },
      error: null,
    });
  });

  test("returns empty timestamps and an error for malformed plist data", () => {
    const parsed = parseDevicePlist("<plist><dict>");

    expect(parsed.value).toEqual({ lastUsedAt: null, lastBootedAt: null });
    expect(parsed.error).not.toBeNull();
  });
});
