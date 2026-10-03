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
  // Three commands can each make three 15-second attempts; leave room for install and cleanup.
  test("reads change count, text, and an item snapshot from the simulator", async () => {
    execFileSync("xcrun", ["simctl", "install", udid!, app!], { timeout: 30_000 });
    try {
      const tool = join(app!, "serve-sim-pasteboard");
      const run = async (command: string): Promise<string> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return execFileSync("xcrun", ["simctl", "spawn", udid!, tool, command], {
              encoding: "utf8", timeout: 15_000,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT" || attempt === 2) throw error;
            await Bun.sleep(500);
          }
        }
        throw new Error(`Could not run ${command}`);
      };

      expect((await run("--change-count")).trim()).toMatch(/^\d+$/);
      const text = await run("--read-text");
      const [hasText, encoded] = (await run("--snapshot")).trimEnd().split("\n");
      expect(hasText).toBe(text.length > 0 ? "1" : "0");
      expect(Buffer.from(encoded!, "base64").subarray(0, 8).toString()).toBe("bplist00");
    } finally {
      execFileSync("xcrun", ["simctl", "uninstall", udid!, bundleId], { timeout: 30_000 });
    }
  }, 240_000);
});
