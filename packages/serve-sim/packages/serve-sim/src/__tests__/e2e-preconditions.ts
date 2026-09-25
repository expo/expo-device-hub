import { expect, test } from "bun:test";
import { execFileSync } from "child_process";

import { findBootedDevice } from "../device";

/** Use the pinned simulator when provided; never fall back from an invalid pin. */
export function e2eDevice(): string | null {
  const pinned = process.env.SERVE_SIM_TEST_UDID?.trim();
  const udid = pinned && pinned.length > 0 ? pinned : findBootedDevice();
  if (!udid) return unavailableE2EDevice(pinned);
  let out: string;
  try {
    out = execFileSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch {
    return unavailableE2EDevice(pinned);
  }
  return out.includes(udid) ? udid : unavailableE2EDevice(pinned);
}

function unavailableE2EDevice(pinned: string | undefined): null {
  if (process.env.SERVE_SIM_E2E_REQUIRED) {
    const message = pinned
      ? `the simulator pinned by SERVE_SIM_TEST_UDID (${pinned}) is not booted`
      : "no booted simulator is available";
    throw new Error(`${message}; boot it before running the required simulator E2E suite`);
  }
  return null;
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
