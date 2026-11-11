import {
  configureCapability,
  isCapabilityArmed,
  isCapabilityEnabled,
  readLaunchState,
  rearmCapabilityLoader,
  releaseSession,
  releaseSessionSync,
} from "../runtime/manager";
import { LaunchStateLockedError } from "../runtime/lock";
import { clipboardCapability } from "./definition";
import { createCapabilitySession, type CapabilitySessionBackend } from "../runtime/session";

// An exit listener cannot wait for long. A lock that another process holds past this is left to
// that process, which drops this process's records once it is gone.
const EXIT_LOCK_TIMEOUT_MS = 5_000;

const setUpInProcess = new Set<string>();
let releasesOnExit = false;

function ownedByThisProcess(udid: string): boolean {
  const state = readLaunchState(udid);
  return (
    !!state &&
    (Object.values(state.capabilities).some(({ ownerPid }) => ownerPid === process.pid) ||
      (state.sessionPids ?? []).includes(process.pid))
  );
}

/**
 * The process that sets up the loader removes it (LLP 0007). The middleware does not own the
 * host's signals, so it releases on `exit`, which a host such as the Hub reaches with
 * `process.exit`. `dispose()` releases earlier; a device it already released is skipped.
 */
function releaseOnExit(udid: string): void {
  setUpInProcess.add(udid);
  if (releasesOnExit) return;
  releasesOnExit = true;
  process.on("exit", () => {
    for (const device of setUpInProcess) {
      if (!ownedByThisProcess(device)) continue;
      try {
        releaseSessionSync(device, process.pid, () => {}, EXIT_LOCK_TIMEOUT_MS);
      } catch (error) {
        console.error(
          `[serve-sim] Could not release the clipboard reader on ${device} at exit: ${exitReleaseFailure(error)}`,
        );
      }
    }
  });
}

// The lock errors tell a running command to retry later, which a process that is exiting cannot do.
function exitReleaseFailure(error: unknown): string {
  if (!(error instanceof LaunchStateLockedError))
    return error instanceof Error ? error.message : String(error);
  const holder = error.heldByThisProcess
    ? "an update in this process still holds the device lock"
    : `another process held the device lock for ${EXIT_LOCK_TIMEOUT_MS / 1000} s`;
  return `${holder}. The loader can stay until the simulator reboots or serve-sim sets it up again.`;
}

const backend: CapabilitySessionBackend = {
  ownerPid: process.pid,
  configure: (udid, definition, enabled) =>
    configureCapability(udid, definition, { enabled, relaunch: false }),
  isEnabled: isCapabilityEnabled,
  isArmed: isCapabilityArmed,
  readState: readLaunchState,
  rearm: rearmCapabilityLoader,
  release: (udid) => releaseSession(udid, process.pid, () => {}),
  acquired: releaseOnExit,
};

export function createClipboardSession(enabled = true, options: { now?: () => number } = {}) {
  return createCapabilitySession(clipboardCapability, enabled, backend, options);
}
