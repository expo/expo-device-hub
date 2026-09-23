import { expect, test } from "bun:test";
import { execFileSync } from "child_process";

import { findBootedDevice } from "../device";

/** Use the pinned simulator when provided; never fall back from an invalid pin. */
export function e2eDevice(): string | null {
  const pinned = process.env.SERVE_SIM_TEST_UDID?.trim();
  const udid = pinned && pinned.length > 0 ? pinned : findBootedDevice();
  if (!udid) return null;
  try {
    const out = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    return out.includes(udid) ? udid : null;
  } catch {
    return null;
  }
}

/** Null means the check failed; an empty string means no insert is set. */
export function readInsert(udid: string): string | null {
  try {
    return execFileSync(
      "xcrun",
      ["simctl", "spawn", udid, "launchctl", "getenv", "DYLD_INSERT_LIBRARIES"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
    ).trim();
  } catch {
    return null;
  }
}

/** CI requires preconditions to fail explicitly instead of silently skipping. */
export function requireE2E(what: string, ready: boolean): void {
  test(`preconditions for ${what}`, () => {
    if (process.env.SERVE_SIM_E2E_REQUIRED) {
      expect(ready, `${what} cannot run here, and this environment requires it`).toBe(true);
    } else if (!ready) {
      console.warn(`skipping ${what}: no booted simulator or missing build artifacts`);
    }
  });
}
