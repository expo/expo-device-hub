import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "child_process";
import { createHash } from "crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { locateSimpbArtifact } from "../sim-pasteboard";
import { copyFromSim } from "../sim-pasteboard-copy";
import { e2eDevice, requireE2E } from "./e2e-preconditions";
import { pasteboardTool, writeTestPasteboard } from "./pasteboard-sim";

const udid = e2eDevice();
const app = locateSimpbArtifact("ServeSimPasteboard.app");
const bundleId = "com.expo.serve-sim-pasteboard";
const ready = !!(udid && app && pasteboardTool);
requireE2E("native pasteboard inspection tool", ready);

function installedApp(): string {
  return execFileSync("xcrun", ["simctl", "get_app_container", udid!, bundleId, "app"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

function uninstall(): void {
  execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 30_000 });
}

function changeCount(): number {
  return Number(
    execFileSync("xcrun", ["simctl", "spawn", udid!, pasteboardTool!, "--change-count"], {
      encoding: "utf8",
      timeout: 30_000,
    }).trim(),
  );
}

function executableHash(appPath: string): string {
  return createHash("sha256")
    .update(readFileSync(join(appPath, "serve-sim-pasteboard")))
    .digest("hex");
}

function sizeAndTime(path: string): [number, number] {
  const { size, mtimeMs } = statSync(path);
  return [size, mtimeMs];
}

(ready ? describe : describe.skip)(`native pasteboard tool (${udid ?? "<skipped>"})`, () => {
  test("reads change count, text, and an item snapshot from the simulator", () => {
    execFileSync("xcrun", ["simctl", "install", udid!, app!], { timeout: 30_000 });
    try {
      const tool = join(installedApp(), "serve-sim-pasteboard");
      const run = (command: string) =>
        execFileSync("xcrun", ["simctl", "spawn", udid!, tool, command], {
          encoding: "utf8",
          timeout: 30_000,
        });
      const expected = "clipboard inspection 🧪\nsecond line";
      execFileSync("xcrun", ["simctl", "spawn", udid!, tool, "--write"], {
        input: expected,
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(run("--change-count").trim()).toMatch(/^\d+$/);
      const text = run("--read-text");
      expect(text).toBe(expected);
      const [hasText, encoded] = run("--snapshot").trimEnd().split("\n");
      expect(hasText).toBe(text.length > 0 ? "1" : "0");
      expect(Buffer.from(encoded!, "base64").subarray(0, 8).toString()).toBe("bplist00");
    } finally {
      uninstall();
    }
  }, 60_000);

  test("writes only with --write, so an empty --write still clears the text", () => {
    execFileSync("xcrun", ["simctl", "install", udid!, app!], { timeout: 30_000 });
    try {
      const tool = join(installedApp(), "serve-sim-pasteboard");
      const spawnTool = (args: string[], input: string) =>
        spawnSync("xcrun", ["simctl", "spawn", udid!, tool, ...args], {
          input,
          encoding: "utf8",
          timeout: 30_000,
        });
      const read = () => spawnTool(["--read-text"], "").stdout;
      expect(spawnTool(["--write"], "kept").status).toBe(0);
      const before = changeCount();

      const noArguments = spawnTool([], "replaced");
      expect(noArguments.status).toBe(2);
      expect(noArguments.stderr).toContain("usage:");
      expect(read()).toBe("kept");
      expect(changeCount()).toBe(before);

      expect(spawnTool(["--write"], "").status).toBe(0);
      expect(read()).toBe("");
      expect(changeCount()).toBe(before + 1);
    } finally {
      uninstall();
    }
  }, 60_000);

  // The app is visible on the Home screen, so a user can start it with a tap.
  test("launching the installed app without arguments leaves the pasteboard unchanged", async () => {
    try {
      const expected = "launch probe";
      // Copy installs and grants the app. The copied text is the content that the launch must keep.
      expect(
        (await copyFromSim(udid!, async () => writeTestPasteboard(udid!, expected))).text,
      ).toBe(expected);
      const before = changeCount();

      execFileSync("xcrun", ["simctl", "launch", udid!, bundleId], { timeout: 30_000 });
      await Bun.sleep(2_000);

      const text = execFileSync(
        "xcrun",
        ["simctl", "spawn", udid!, join(app!, "serve-sim-pasteboard"), "--read-text"],
        {
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      expect(text).toBe(expected);
      expect(changeCount()).toBe(before);
    } finally {
      uninstall();
    }
  }, 60_000);

  test("Copy replaces an installed app whose executable differs from the shipped one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "serve-sim-outdated-pasteboard-"));
    try {
      // A signing identifier of the same length changes the executable bytes but not the size, as
      // an older build does. With the same modification time too, an install keeps the old file.
      const outdated = join(dir, "ServeSimPasteboard.app");
      const shipped = join(app!, "serve-sim-pasteboard");
      cpSync(app!, outdated, { recursive: true });
      execFileSync(
        "codesign",
        ["--force", "--sign", "-", "--identifier", bundleId.toUpperCase(), outdated],
        {
          stdio: "ignore",
        },
      );
      execFileSync("touch", ["-r", shipped, join(outdated, "serve-sim-pasteboard")]);
      expect(sizeAndTime(join(outdated, "serve-sim-pasteboard"))).toEqual(sizeAndTime(shipped));
      execFileSync("xcrun", ["simctl", "install", udid!, outdated], { timeout: 30_000 });
      expect(executableHash(installedApp())).not.toBe(executableHash(app!));

      const expected = "outdated helper probe";
      expect(
        (await copyFromSim(udid!, async () => writeTestPasteboard(udid!, expected))).text,
      ).toBe(expected);
      const replaced = installedApp();
      expect(executableHash(replaced)).toBe(executableHash(app!));

      // An install moves the app to a new container, so the same path shows that Copy kept it.
      await copyFromSim(udid!, async () => writeTestPasteboard(udid!, "second copy"));
      expect(installedApp()).toBe(replaced);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      uninstall();
    }
  }, 60_000);
});
