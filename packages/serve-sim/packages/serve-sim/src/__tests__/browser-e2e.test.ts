import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

test.each(["timeout", "empty", "launch-timeout", "launch-failure"])(
  "browser discovery tolerates a transient %s response",
  (mode) => {
    const root = mkdtempSync(join(tmpdir(), "serve-sim-browser-startup-"));
    try {
      const chrome = join(import.meta.dir, "fixtures/browser-chrome.child.ts");
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dir, "fixtures/browser-startup.child.ts")],
        {
          env: {
            ...process.env,
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
            SERVE_SIM_CHROME: chrome,
            SERVE_SIM_BROWSER_FIXTURE_MODE: mode,
            SERVE_SIM_BROWSER_FIXTURE_STATE: join(root, "attempt"),
            SERVE_SIM_BROWSER_STARTUP_TEST_MS: mode.startsWith("launch-") ? "1000" : "15000",
          },
          encoding: "utf8",
          timeout: 20000,
        },
      );
      if (mode === "launch-failure") {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("fixture launch blocked");
      } else {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("BROWSER_READY");
      }
      const profiles = readFileSync(join(root, "attempt.profiles"), "utf8").trim().split("\n");
      expect(profiles).toHaveLength(mode.startsWith("launch-") ? 2 : 1);
      for (const profile of profiles) expect(existsSync(profile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);
