import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("rejects arguments with characters cmd.exe acts on inside quotes", () => {
    for (const arg of ["100%", "a!b", "a^b", 'say "hi"', "a\nb", "a\r\nb"]) {
      expect(() => buildBatchCommand("tool.bat", ["create", arg])).toThrow("Refusing");
    }
  });

  test("rejects arguments ending in a backslash, which would escape the closing quote", () => {
    // Quoted, this becomes `"…x86_64\"`: Java reads `\"` as a literal quote and
    // splits the following arguments in the wrong places.
    for (const arg of ["system-images;android-34;x86_64\\", "pixel 6\\\\", "a\\"]) {
      expect(() => buildBatchCommand("tool.bat", ["create", arg])).toThrow("Refusing");
    }
  });

  test("still runs a tool under a home folder named with those characters", () => {
    expect(buildBatchCommand("C:\\Users\\a^b\\sdk\\avdmanager.bat", ["list", "avd"])).toBe(
      '"C:\\Users\\a^b\\sdk\\avdmanager.bat" list avd',
    );
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
        "3.2in HVGA slider (ADP1)",
      ]);

      expect(stdout.trim()).toBe(
        '--package "system-images;android-36.1;google_apis_playstore;x86_64" ' +
          '--device "3.2in HVGA slider (ADP1)"',
      );
    });

    test("kills the wrapper's child process when the signal aborts", async () => {
      // Like avdmanager.bat starting a JVM: the wrapper's child holds the
      // output pipes and outlives cmd.exe unless the whole tree is killed.
      const pidFile = join(directory, "child.pid");
      const stalled = join(directory, "stalled.bat");
      // Single quotes only: the script sits inside cmd.exe double quotes.
      const quotedPidFile = `'${pidFile.replaceAll("\\", "\\\\")}'`;
      const child = `require('fs').writeFileSync(${quotedPidFile}, String(process.pid)); setInterval(() => {}, 1000)`;
      writeFileSync(stalled, `@echo off\r\n"${process.execPath}" -e "${child}"\r\n`);

      const controller = new AbortController();
      const run = execSdkTool(stalled, [], { signal: controller.signal });
      while (!existsSync(pidFile)) await Bun.sleep(50);
      const pid = Number(readFileSync(pidFile, "utf8"));
      controller.abort();

      await expect(run).rejects.toBeDefined();
      const isRunning = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 5000;
      while (isRunning() && Date.now() < deadline) await Bun.sleep(100);
      expect(isRunning()).toBe(false);
    });
  });
});
