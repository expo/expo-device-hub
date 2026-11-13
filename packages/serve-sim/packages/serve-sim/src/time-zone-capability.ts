import { existsSync } from "fs";
import { join } from "path";
import type { CapabilityDefinition } from "./capabilities";
import {
  capabilityFileDir,
  deviceSessionPid,
  withCapabilityFileLock,
  writeCapabilityFile,
} from "./capability-files";
import { capabilityLoaderDir, configureCapability } from "./launch-manager";

/** The zone the dylib follows: an IANA name, or "host". */
export function timeZoneFile(udid: string): string {
  return join(capabilityFileDir("time-zone", udid), "zone");
}

export function writeTimeZoneFile(udid: string, zone: string): void {
  writeCapabilityFile(timeZoneFile(udid), zone);
}

export function withTimeZoneLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  return withCapabilityFileLock("time-zone", udid, "time zone", fn);
}

export function timeZoneDylib(): string {
  return join(capabilityLoaderDir(), "libServeSimTimeZone.dylib");
}

// Not registered for `--enable`: it only means something with a zone, set through `ui time-zone`.
const timeZoneCapability: CapabilityDefinition = {
  name: "time-zone",
  defaultEnabled: false,
  // Apple apps too: Safari and Settings should agree with the app under test.
  scope: "allApps",
  async setEnabled({ udid, enabled }) {
    if (!enabled) return null;
    const dylib = timeZoneDylib();
    if (!existsSync(dylib)) {
      throw new Error(
        `${dylib} is missing, so running apps cannot switch zones. Run \`bun run build\` in ` +
          `packages/serve-sim to build the native artifacts, then retry.`,
      );
    }
    return { dylib, env: { SERVE_SIM_TIME_ZONE_FILE: timeZoneFile(udid) } };
  },
};

/**
 * Owned by the device's session, like any capability, so it ends with that session. With no
 * session, apps get the zone from launchd at their next launch. No relaunch: the dylib switches apps.
 */
export async function setTimeZoneCapability(udid: string, enabled: boolean): Promise<void> {
  const ownerPid = deviceSessionPid(udid);
  if (ownerPid === null) return;
  await configureCapability(udid, timeZoneCapability, { enabled, ownerPid, relaunch: false });
}
