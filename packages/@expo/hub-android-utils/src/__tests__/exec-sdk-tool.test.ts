import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBatchCommand, execSdkTool, isBatchFile } from "../exec-sdk-tool";

describe("isBatchFile", () => {
  test("matches .bat and .cmd regardless of case", () => {
    expect(isBatchFile("C:\\sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat")).toBe(true);
    expect(isBatchFile("C:\\tool.CMD")).toBe(true);
  });

  test("ignores native binaries", () => {
    expect(isBatchFile("/sdk/cmdline-tools/latest/bin/avdmanager")).toBe(false);
    expect(isBatchFile("C:\\sdk\\platform-tools\\adb.exe")).toBe(false);
  });
});

describe("buildBatchCommand", () => {
  test("leaves path-safe arguments bare", () => {
    expect(buildBatchCommand("C:\\sdk\\avdmanager.bat", ["list", "avd"])).toBe(
      "C:\\sdk\\avdmanager.bat list avd",
    );
  });

  test("quotes arguments cmd.exe would otherwise split", () => {
    const command = buildBatchCommand("C:\\Program Files\\sdk\\avdmanager.bat", [
      "create",
      "avd",
      "--name",
      "expo-emu-host-0",
      "--package",
      "system-images;android-36.1;google_apis_playstore;x86_64",
      "--device",
      "pixel 6",
    ]);

    expect(command).toBe(
      '"C:\\Program Files\\sdk\\avdmanager.bat" create avd --name expo-emu-host-0 ' +
        '--package "system-images;android-36.1;google_apis_playstore;x86_64" --device "pixel 6"',
    );
  });

  test("escapes embedded double quotes", () => {
    expect(buildBatchCommand("tool.bat", ['say "hi"'])).toBe('tool.bat "say ""hi"""');
  });
});

describe("execSdkTool", () => {
  test("spawns native binaries directly with their arguments", async () => {
    const { stdout } = await execSdkTool(process.execPath, ["-e", "console.log('direct')"]);
    expect(stdout.trim()).toBe("direct");
  });

  describe.skipIf(process.platform !== "win32")("on Windows", () => {
    let directory = "";
    let echoArgs = "";

    beforeAll(() => {
      // The space in the directory name exercises quoting of the tool path itself.
      directory = mkdtempSync(join(tmpdir(), "hub android-"));
      echoArgs = join(directory, "echo-args.bat");
      writeFileSync(echoArgs, "@echo off\r\necho %*\r\n");
    });

    afterAll(() => {
      rmSync(directory, { recursive: true, force: true });
    });

    test("runs a .bat wrapper and keeps quoted arguments whole", async () => {
      const { stdout } = await execSdkTool(echoArgs, [
        "--package",
        "system-images;android-36.1;google_apis_playstore;x86_64",
        "--device",
        "pixel 6",
      ]);

      expect(stdout.trim()).toBe(
        '--package "system-images;android-36.1;google_apis_playstore;x86_64" --device "pixel 6"',
      );
    });
  });
});
