import { describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  firstBootedIosSim,
  isHeadlessPasteboard,
  pasteboardTool as tool,
  writeTestPasteboard,
} from "./pasteboard-sim";
import { requireE2E } from "./e2e-preconditions";

const udid = firstBootedIosSim();

const skipOnCi = !!process.env.CI && process.env.SERVE_SIM_CLIPBOARD_E2E !== "1";
if (skipOnCi) {
  console.warn(
    "[sim-clipboard.e2e] skipping on CI: simulator pasteboard round-trip is unreliable on shared runners (set SERVE_SIM_CLIPBOARD_E2E=1 to force)",
  );
}

// The CI skip is by design, so it gates the suite but not the precondition.
const ready = !!(udid && tool);
requireE2E("simulator clipboard E2E", ready);
const describeIfSim = ready && !skipOnCi && !isHeadlessPasteboard() ? describe : describe.skip;

describeIfSim(`simctl pasteboard round-trip (booted sim ${udid ?? "<skipped>"})`, () => {
  test("writer and pbpaste round-trip unicode", () => {
    const text = "café 🎉 email+tag@x.com — 日本語";
    writeTestPasteboard(udid!, text, { ...process.env, LANG: "C", LC_ALL: "C" });
    const got = execFileSync("xcrun", ["simctl", "pbpaste", udid!], {
      encoding: "utf-8",
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
    });
    expect(got).toBe(text);
  });
});
