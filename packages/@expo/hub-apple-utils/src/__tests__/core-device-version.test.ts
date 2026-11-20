import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORE_DEVICE_INFO_PLIST,
  coreDeviceInfoPlist,
  readCoreDeviceVersion,
} from "../core-device-version";

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.apple.dt.CoreDevice</string>
  <key>CFBundleShortVersionString</key>
  <string>651.32</string>
</dict>
</plist>`;

describe("readCoreDeviceVersion", () => {
  test("is null without an error when Xcode has not installed CoreDevice", async () => {
    const read = await readCoreDeviceVersion("/nonexistent/CoreDevice/Info.plist");

    expect(read).toEqual({ value: null, error: null });
  });

  test("reads the binary Info.plist that Xcode installs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "core-device-"));
    try {
      const path = join(directory, "Info.plist");
      await writeFile(path, INFO_PLIST);
      execFileSync("plutil", ["-convert", "binary1", path]);

      expect(await readCoreDeviceVersion(path)).toEqual({ value: "651.32", error: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("coreDeviceInfoPlist", () => {
  test("is the installed CoreDevice's Info.plist", () => {
    expect(coreDeviceInfoPlist({})).toBe(CORE_DEVICE_INFO_PLIST);
    expect(coreDeviceInfoPlist({ SERVE_SIM_COREDEVICE_INFO_PLIST: "" })).toBe(
      CORE_DEVICE_INFO_PLIST,
    );
  });

  test("is the Info.plist that SERVE_SIM_COREDEVICE_INFO_PLIST names, as serve-sim reads it", () => {
    expect(
      coreDeviceInfoPlist({ SERVE_SIM_COREDEVICE_INFO_PLIST: "/tmp/CoreDevice-600.plist" }),
    ).toBe("/tmp/CoreDevice-600.plist");
  });
});
