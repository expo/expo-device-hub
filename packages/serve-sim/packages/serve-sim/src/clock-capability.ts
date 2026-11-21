import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { CapabilityDefinition } from "./capabilities";
import {
  capabilityFileDir,
  deviceSessionPid,
  withCapabilityFileLock,
  writeCapabilityFile,
} from "./capability-files";
import { capabilityLoaderDir, configureCapability } from "./launch-manager";
import { readLaunchState } from "./launch-state";
import { UiInputError } from "./ui-input-error";

/** About 200 years either way, as the dylib accepts. */
export const MAX_CLOCK_OFFSET_MS = 6_300_000_000_000;

/** How far the dylib shifts the wall clock, in milliseconds; 0 for the Mac's time. */
export function clockFile(udid: string): string {
  return join(capabilityFileDir("clock", udid), "offset");
}

/** 0 when no offset was ever written, or the file is not one. */
export function readClockOffset(udid: string): number {
  try {
    const offset = Number(readFileSync(clockFile(udid), "utf-8").trim());
    return Number.isSafeInteger(offset) ? offset : 0;
  } catch {
    return 0;
  }
}

export function writeClockOffset(udid: string, offsetMs: number): void {
  writeCapabilityFile(clockFile(udid), String(offsetMs));
}

export function withClockLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  return withCapabilityFileLock("clock", udid, "clock", fn);
}

export function clockDylib(): string {
  return join(capabilityLoaderDir(), "libServeSimClock.dylib");
}

// Not registered for `--enable`: it only means something with a time, set through `ui clock`.
const clockCapability: CapabilityDefinition = {
  name: "clock",
  defaultEnabled: false,
  // Apple apps too: Safari and Settings should agree with the app under test.
  scope: "allApps",
  // At exec, so an app's first read of the clock is already shifted; running apps load it later.
  loadPhase: "startupAndDeferred",
  async setEnabled({ udid, enabled }) {
    if (!enabled) return null;
    const dylib = clockDylib();
    if (!existsSync(dylib)) {
      throw new Error(
        `${dylib} is missing, so apps cannot use another time. Run \`bun run build\` in ` +
          `packages/serve-sim to build the native artifacts, then retry.`,
      );
    }
    return { dylib, env: { SERVE_SIM_CLOCK_FILE: clockFile(udid) } };
  },
};

/** Whether a live session still holds the clock capability; the offset file outlives it. */
export function clockCapabilityEnabled(udid: string): boolean {
  return Object.values(readLaunchState(udid)?.capabilities ?? {}).some(
    (record) => record.name === clockCapability.name,
  );
}

/**
 * Owned by the device's session, like any capability, so it ends with that session. Unlike the
 * time zone, nothing outside the dylib can shift the clock, so a time needs a session.
 */
export async function setClockCapability(udid: string, enabled: boolean): Promise<void> {
  const ownerPid = deviceSessionPid(udid);
  if (ownerPid === null) {
    if (!enabled) return;
    throw new UiInputError(
      `Setting the clock of ${udid} needs a serve-sim session that owns the device: run ` +
        "`serve-sim` in the foreground or open the device in the Hub, then retry.",
    );
  }
  await configureCapability(udid, clockCapability, { enabled, ownerPid, relaunch: false });
}
