import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { CapabilityDefinition } from "./capabilities";
import { capabilityLoaderDir, configureCapability } from "./launch-manager";
import { readLaunchState } from "./launch-state";
import { stateDir } from "./state";
import { withStateLock } from "./state-lock";

const deviceDir = (udid: string) => join(stateDir(), `time-zone-${encodeURIComponent(udid)}`);

/**
 * The dylib watches this file: the loader never reloads a dylib, so the zone cannot travel
 * in the capability config. One directory per device, so other devices' writes do not wake it.
 */
export function timeZoneFile(udid: string): string {
  return join(deviceDir(udid), "zone");
}

/** Atomic, because the dylib may read at any moment. */
export function writeTimeZoneFile(udid: string, zone: string): void {
  const file = timeZoneFile(udid);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${zone}\n`);
  renameSync(temp, file);
}

/** One zone change at a time per device. Outside the watched directory, so it does not wake the dylib. */
export function withTimeZoneLock<T>(udid: string, fn: () => Promise<T>): Promise<T> {
  const path = `${deviceDir(udid)}.lock`;
  return withStateLock(
    path,
    30_000,
    () =>
      new Error(
        `Timed out waiting to change the time zone of ${udid}. Another serve-sim command is holding ${path}. ` +
          "Wait for it to finish, or remove that file if nothing is running.",
      ),
    fn,
  );
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
 * A live process that already owns the device's loader state, so it removes the insert when it
 * exits (LLP 0007), or null. Never a detached stream helper: those do not arm the loader.
 */
export function deviceSessionPid(udid: string): number | null {
  const state = readLaunchState(udid);
  if (!state) return null;
  const owners = [
    ...(state.sessionPids ?? []),
    ...Object.values(state.capabilities).map((record) => record.ownerPid),
  ];
  return owners.find((pid) => pid !== null) ?? null;
}

/**
 * Owned by the device's session, like any capability, so it ends with that session. With no
 * session, apps get the zone from launchd at their next launch. No relaunch: the dylib switches apps.
 */
export async function setTimeZoneCapability(udid: string, enabled: boolean): Promise<void> {
  const ownerPid = deviceSessionPid(udid);
  if (ownerPid === null) return;
  await configureCapability(udid, timeZoneCapability, { enabled, ownerPid, relaunch: false });
}
