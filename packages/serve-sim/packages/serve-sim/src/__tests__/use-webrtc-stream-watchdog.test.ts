import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("first-frame watchdog handles visibility, connection changes, and hung stats", () => {
  // The hook fixture mocks React and browser globals. Isolate it so those mocks cannot
  // change unrelated tests in this Bun process.
  const fixture = fileURLToPath(new URL("./fixtures/use-webrtc-stream-watchdog.fixture.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["test", fixture], { encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
