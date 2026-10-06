import {
  configureCapability,
  isCapabilityArmed,
  isCapabilityEnabled,
  readLaunchState,
  rearmCapabilityLoader,
  releaseSession,
  releaseSessionSync,
} from "./launch-manager";
import { CLIPBOARD_CAPABILITY, clipboardCapability } from "./sim-pasteboard-reader";

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RECHECK_MS = 30_000;
// An exit listener cannot wait for long. A lock that another process holds past this is left to
// that process, which drops this process's records once it is gone.
const EXIT_LOCK_TIMEOUT_MS = 5_000;

const setUpInProcess = new Set<string>();
let releasesOnExit = false;

function ownedByThisProcess(udid: string): boolean {
  const state = readLaunchState(udid);
  return !!state && (
    Object.values(state.capabilities).some(({ ownerPid }) => ownerPid === process.pid)
    || (state.sessionPids ?? []).includes(process.pid)
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
          `[serve-sim] Could not release the clipboard reader on ${device} at exit: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
}

export function createClipboardSession(enabled = true, { now = Date.now }: { now?: () => number } = {}) {
  // Pages, /api polls, and config requests all call initialize(). After a setup succeeds, the launchd
  // check (two simctl spawns) runs at most once per RECHECK_MS per device. That check is what repairs
  // a reboot the middleware did not see.
  const devices = new Map<string, { work: Promise<void>; done: boolean; checkedAt: number }>();
  // A failed setup waits before the next attempt, so a device that keeps failing is not retried and
  // logged on every request. Each failure doubles the wait; a reboot retries at once.
  const failures = new Map<string, { retryAt: number; delayMs: number }>();
  const initializedHere = new Set<string>();
  let disposed = false;

  return {
    initialize(udid: string, rebooted = false): Promise<void> {
      if (disposed) return Promise.resolve();
      if (!rebooted && now() < (failures.get(udid)?.retryAt ?? 0)) return Promise.resolve();
      const previous = devices.get(udid);
      if (previous && !rebooted && (
        !previous.done
        || (!enabled && !isCapabilityEnabled(udid, CLIPBOARD_CAPABILITY))
        || (enabled && now() - previous.checkedAt < RECHECK_MS && isCapabilityEnabled(udid, CLIPBOARD_CAPABILITY))
      )) {
        return previous.work;
      }
      // A reboot clears launchd, so configure the new boot after any setup that started before it.
      const earlier = rebooted && previous && !previous.done ? previous.work.catch(() => {}) : undefined;
      const entry = { work: Promise.resolve(), done: false, checkedAt: 0 };
      entry.work = (async () => {
        await earlier;
        if (enabled && !rebooted && await isCapabilityArmed(udid, CLIPBOARD_CAPABILITY)) return;
        await configureCapability(udid, clipboardCapability, { enabled, relaunch: false });
        if (enabled) {
          initializedHere.add(udid);
          releaseOnExit(udid);
        } else if (readLaunchState(udid)) {
          // Republish without dead owners, including readers left by an earlier session.
          await rearmCapabilityLoader(udid);
          initializedHere.add(udid);
          releaseOnExit(udid);
        }
      })().then(() => {
        entry.done = true;
        entry.checkedAt = now();
        failures.delete(udid);
      }, (error) => {
        if (devices.get(udid) === entry) devices.delete(udid);
        const previousDelayMs = failures.get(udid)?.delayMs;
        const delayMs = previousDelayMs ? Math.min(RETRY_MAX_MS, 2 * previousDelayMs) : RETRY_MIN_MS;
        failures.set(udid, { retryAt: now() + delayMs, delayMs });
        throw error;
      });
      devices.set(udid, entry);
      return entry.work;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...devices.values()].map(({ work }) => work));
      const results = await Promise.allSettled([...initializedHere].map(async (udid) => {
        const clipboard = readLaunchState(udid)?.capabilities[CLIPBOARD_CAPABILITY];
        if (clipboard?.ownerPid === process.pid) {
          await configureCapability(udid, clipboardCapability, { enabled: false, relaunch: false });
        }
        const remaining = Object.values(readLaunchState(udid)?.capabilities ?? {});
        if (!remaining.some(({ ownerPid }) => ownerPid === process.pid)) {
          await releaseSession(udid, process.pid, () => {});
        }
        initializedHere.delete(udid);
      }));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, "Could not release the clipboard session");
    },
  };
}
