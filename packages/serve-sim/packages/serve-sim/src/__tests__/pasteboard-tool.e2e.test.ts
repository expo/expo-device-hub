import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { join } from "path";
import { locateSimpbArtifact } from "../sim-pasteboard";
import { e2eDevice, requireE2E } from "./e2e-preconditions";

const udid = e2eDevice();
const app = locateSimpbArtifact("ServeSimPasteboard.app");
const bundleId = "com.expo.serve-sim-pasteboard";
const ready = !!(udid && app);
requireE2E("native pasteboard inspection tool", ready);

(ready ? describe : describe.skip)(`native pasteboard tool (${udid ?? "<skipped>"})`, () => {
  test("reads change count, text, and an item snapshot from the simulator", () => {
    execFileSync("xcrun", ["simctl", "install", udid!, app!], { timeout: 30_000 });
    try {
      const installed = execFileSync("xcrun", ["simctl", "get_app_container", udid!, bundleId, "app"], {
        encoding: "utf8", timeout: 30_000,
      }).trim();
      const tool = join(installed, "serve-sim-pasteboard");
      const run = (command: string) => execFileSync("xcrun", ["simctl", "spawn", udid!, tool, command], {
        encoding: "utf8", timeout: 30_000,
      });
      const expected = "clipboard inspection 🧪\nsecond line";
      execFileSync("xcrun", ["simctl", "spawn", udid!, tool], {
        input: expected, encoding: "utf8", timeout: 30_000,
      });

      expect(run("--change-count").trim()).toMatch(/^\d+$/);
      const text = run("--read-text");
      expect(text).toBe(expected);
      const [hasText, encoded] = run("--snapshot").trimEnd().split("\n");
      expect(hasText).toBe(text.length > 0 ? "1" : "0");
      expect(Buffer.from(encoded!, "base64").subarray(0, 8).toString()).toBe("bplist00");
    } finally {
      execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 30_000 });
    }
  }, 60_000);
});
