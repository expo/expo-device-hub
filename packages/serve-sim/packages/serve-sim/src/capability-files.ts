import { mkdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { readLaunchState } from "./launch-state";
import { stateDir } from "./state";
import { withStateLock } from "./state-lock";

// A capability whose dylib follows a value that changes while apps run keeps that value in a
// file the dylib watches: the loader never reloads a dylib, so the value cannot travel in the
// capability config.

/** One directory per capability and device, so other devices' writes do not wake the dylib. */
export function capabilityFileDir(name: string, udid: string): string {
  return join(stateDir(), `${name}-${encodeURIComponent(udid)}`);
}

/** Atomic, because the dylib may read at any moment. */
export function writeCapabilityFile(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${text}\n`);
  renameSync(temp, file);
}

/** One change at a time per device. Outside the watched directory, so it does not wake the dylib. */
export function withCapabilityFileLock<T>(
  name: string,
  udid: string,
  change: string,
  fn: () => Promise<T>,
): Promise<T> {
  const path = `${capabilityFileDir(name, udid)}.lock`;
  return withStateLock(
    path,
    30_000,
    () =>
      new Error(
        `Timed out waiting to change the ${change} of ${udid}. Another serve-sim command is holding ${path}. ` +
          "Wait for it to finish, or remove that file if nothing is running.",
      ),
    fn,
  );
}

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
