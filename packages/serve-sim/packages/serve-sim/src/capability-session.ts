import {
  configureCapability,
  isCapabilityArmed,
  isCapabilityEnabled,
  readLaunchState,
  rearmCapabilityLoader,
  releaseSession,
  releaseSessionSync,
} from "./launch-manager";
import type { CapabilityDefinition } from "./capabilities";
import { LaunchStateLockedError } from "./launch-state-lock";
import { ownerIsGone } from "./launch-state";
import { KEYCHAIN_CAPABILITY } from "./sim-keychain";
import { CLIPBOARD_CAPABILITY } from "./sim-pasteboard-reader";

/** The capabilities a preview sets up on each device it opens; `capabilities.set` switches them. */
export const SESSION_CAPABILITIES = [CLIPBOARD_CAPABILITY, KEYCHAIN_CAPABILITY] as const;
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number];

/** What host actions reach: the middleware's sessions. */
export interface CapabilityController {
  list(udid: string): { name: SessionCapability; enabled: boolean }[];
  set(udid: string, name: SessionCapability, enabled: boolean): Promise<void>;
  /** False when this server turned the capability off for the device, whoever set it up. */
  allows(udid: string, name: SessionCapability): boolean;
}

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
          `[serve-sim] Could not release the capability loader on ${device} at exit: ${exitReleaseFailure(error)}`,
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

/**
 * Sets up one default capability on each device the middleware opens or starts, keeps it in place,
 * and releases it on `dispose()` or at exit. `setEnabled` switches it on one device until dispose;
 * a capability the session starts disabled stays off.
 */
export function createCapabilitySession(
  definition: CapabilityDefinition,
  enabled = true,
  { now = Date.now }: { now?: () => number } = {},
) {
  // Pages, /api polls, and config requests all call initialize(). After a setup succeeds, the launchd
  // check (two simctl spawns) runs at most once per RECHECK_MS per device. That check is what repairs
  // a reboot the middleware did not see.
  const devices = new Map<string, { work: Promise<void>; done: boolean; checkedAt: number }>();
  // Per-device choices from `setEnabled`; the periodic check keeps them rather than `enabled`.
  const choices = new Map<string, boolean>();
  const wanted = (udid: string) => choices.get(udid) ?? enabled;
  // A running process that set the capability up would set it up again on its next check, so
  // turning it off here leaves that record; this server's own actions still refuse it.
  const ownedElsewhere = (udid: string) => {
    const owner = readLaunchState(udid)?.capabilities[definition.name]?.ownerPid;
    return owner != null && owner !== process.pid && !ownerIsGone(owner);
  };
  // A failed setup waits before the next attempt, so a device that keeps failing is not retried and
  // logged on every request. Each failure doubles the wait; a reboot or a choice retries at once.
  const failures = new Map<string, { retryAt: number; delayMs: number }>();
  const initializedHere = new Set<string>();
  let disposed = false;

  /** Whether the last setup still holds, so a call can share it instead of starting another. */
  function stillHolds(udid: string, previous: { done: boolean; checkedAt: number }): boolean {
    if (!previous.done) return true;
    if (!wanted(udid)) return !isCapabilityEnabled(udid, definition.name) || ownedElsewhere(udid);
    return now() - previous.checkedAt < RECHECK_MS && isCapabilityEnabled(udid, definition.name);
  }

  /**
   * `force` is for a reboot, which clears launchd, and for a new choice, which reverses the last
   * one: it skips the retry wait and the shared setup, and runs after any setup still running.
   */
  function initialize(udid: string, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!force && now() < (failures.get(udid)?.retryAt ?? 0)) return Promise.resolve();
    const want = wanted(udid);
    const previous = devices.get(udid);
    if (previous && !force && stillHolds(udid, previous)) return previous.work;
    const earlier = previous && !previous.done ? previous.work.catch(() => {}) : undefined;
    const entry = { work: Promise.resolve(), done: false, checkedAt: 0 };
    entry.work = (async () => {
      await earlier;
      // Another running process's setup stays its own; a forced setup redoes only this server's.
      if (
        want &&
        (!force || ownedElsewhere(udid)) &&
        (await isCapabilityArmed(udid, definition.name))
      )
        return;
      if (!want && ownedElsewhere(udid)) return;
      await configureCapability(udid, definition, { enabled: want, relaunch: false });
      if (!want) {
        if (!readLaunchState(udid)) return;
        // Republish without dead owners, including readers left by an earlier session.
        await rearmCapabilityLoader(udid);
      }
      initializedHere.add(udid);
      releaseOnExit(udid);
    })().then(
      () => {
        entry.done = true;
        entry.checkedAt = now();
        failures.delete(udid);
      },
      (error) => {
        if (devices.get(udid) === entry) devices.delete(udid);
        const previousDelayMs = failures.get(udid)?.delayMs;
        const delayMs = previousDelayMs
          ? Math.min(RETRY_MAX_MS, 2 * previousDelayMs)
          : RETRY_MIN_MS;
        failures.set(udid, { retryAt: now() + delayMs, delayMs });
        throw error;
      },
    );
    devices.set(udid, entry);
    return entry.work;
  }

  return {
    initialize,
    /** Whether this server lets the capability work on the device: the startup setting or a choice. */
    allows: wanted,
    async setEnabled(udid: string, value: boolean): Promise<void> {
      if (disposed) throw new Error(`The ${definition.name} session has ended.`);
      if (value && !enabled) {
        throw new Error(
          `This server started with ${definition.name} disabled. Restart it without --disable ${definition.name} to turn it on.`,
        );
      }
      if (!devices.has(udid) && !failures.has(udid)) {
        throw new Error(`This server has not opened ${udid}.`);
      }
      choices.set(udid, value);
      await initialize(udid, true);
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...devices.values()].map(({ work }) => work));
      const results = await Promise.allSettled(
        [...initializedHere].map(async (udid) => {
          const record = readLaunchState(udid)?.capabilities[definition.name];
          if (record?.ownerPid === process.pid) {
            await configureCapability(udid, definition, {
              enabled: false,
              relaunch: false,
            });
          }
          const remaining = Object.values(readLaunchState(udid)?.capabilities ?? {});
          if (!remaining.some(({ ownerPid }) => ownerPid === process.pid)) {
            await releaseSession(udid, process.pid, () => {});
          }
          initializedHere.delete(udid);
        }),
      );
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length > 0)
        throw new AggregateError(errors, `Could not release the ${definition.name} session`);
    },
  };
}

export type CapabilitySession = ReturnType<typeof createCapabilitySession>;

/**
 * A null session is a capability the middleware does not manage: one it leaves `"unmanaged"`, or
 * keychain without its library. It is neither listed nor switched.
 */
export function createCapabilityController(
  sessions: Record<SessionCapability, CapabilitySession | null>,
  onChange: () => void = () => {},
): CapabilityController {
  return {
    // On only where this server allows it and the device has it set up, so a reply never shows a
    // capability on that this server's actions refuse.
    list: (udid) =>
      SESSION_CAPABILITIES.flatMap((name) => {
        const session = sessions[name];
        return session
          ? [{ name, enabled: session.allows(udid) && isCapabilityEnabled(udid, name) }]
          : [];
      }),
    async set(udid, name, enabled) {
      const session = sessions[name];
      if (!session) throw new Error(`This server does not manage ${name}.`);
      // A choice can leave the launch state as it was, so watchers of that state would miss it.
      try {
        await session.setEnabled(udid, enabled);
      } finally {
        onChange();
      }
    },
    allows: (udid, name) => sessions[name]?.allows(udid) ?? true,
  };
}
