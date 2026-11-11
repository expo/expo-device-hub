import type { CapabilityDefinition } from "./capability";

export interface CapabilitySessionBackend {
  readonly ownerPid: number;
  configure(udid: string, definition: CapabilityDefinition, enabled: boolean): Promise<void>;
  isEnabled(udid: string, name: string): boolean;
  isArmed(udid: string, name: string): Promise<boolean>;
  readState(udid: string): {
    capabilities: Record<string, { ownerPid: number | null }>;
  } | null;
  rearm(udid: string): Promise<void>;
  release(udid: string): Promise<void>;
  /** Only called after owned setup, never when sharing an already-armed capability. */
  acquired(udid: string): void;
}

const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const RECHECK_MS = 30_000;

export function createCapabilitySession(
  definition: CapabilityDefinition,
  enabled: boolean,
  backend: CapabilitySessionBackend,
  { now = Date.now }: { now?: () => number } = {},
) {
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
      if (
        previous &&
        !rebooted &&
        (!previous.done ||
          (!enabled && !backend.isEnabled(udid, definition.name)) ||
          (enabled &&
            now() - previous.checkedAt < RECHECK_MS &&
            backend.isEnabled(udid, definition.name)))
      ) {
        return previous.work;
      }
      // A reboot clears launchd, so configure the new boot after any setup that started before it.
      const earlier =
        rebooted && previous && !previous.done ? previous.work.catch(() => {}) : undefined;
      const entry = { work: Promise.resolve(), done: false, checkedAt: 0 };
      entry.work = (async () => {
        await earlier;
        if (enabled && !rebooted && (await backend.isArmed(udid, definition.name))) return;
        await backend.configure(udid, definition, enabled);
        if (enabled) {
          initializedHere.add(udid);
          backend.acquired(udid);
        } else if (backend.readState(udid)) {
          // Republish without dead owners, including readers left by an earlier session.
          await backend.rearm(udid);
          initializedHere.add(udid);
          backend.acquired(udid);
        }
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
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.allSettled([...devices.values()].map(({ work }) => work));
      const results = await Promise.allSettled(
        [...initializedHere].map(async (udid) => {
          const record = backend.readState(udid)?.capabilities[definition.name];
          if (record?.ownerPid === backend.ownerPid) {
            await backend.configure(udid, definition, false);
          }
          const remaining = Object.values(backend.readState(udid)?.capabilities ?? {});
          if (!remaining.some(({ ownerPid }) => ownerPid === backend.ownerPid)) {
            await backend.release(udid);
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
