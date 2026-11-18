import type { ScreenOrientation } from "./shared/api-contracts.ts";

const MAX_AGE_MS = 1_000;
const FRESH_WAIT_MS = 300;

export type DisplayOrientationReader = {
  /**
   * A new reading that starts now and never shares an earlier one. Resolves null when the read
   * fails, or when a lock is in flight or lands before the read finishes, so it never reports a
   * pose a command is changing. `generation` changes with every lock command, so two readings
   * with the same generation had no Hub command between them. A newer success also becomes the
   * cached reading.
   */
  observe(): Promise<Readonly<{ orientation: ScreenOrientation; generation: number }> | null>;
  /**
   * The last reading, or null before the first one. Starts a new reading in the background
   * when this one is older than a second, for the synchronous `/health` snapshot. The reader
   * polls adb only when asked; a failed read keeps the last value.
   */
  current(): ScreenOrientation | null;
  /**
   * The reading for `/api`: a stale one waits up to 300 ms for a new query, so a client that
   * polls after a turn sees the new pose instead of the one before it.
   */
  fresh(): Promise<ScreenOrientation | null>;
};

export type DisplayOrientationReaderOptions = {
  /** Read the pose the display shows now. */
  read: () => Promise<ScreenOrientation>;
  now?: () => number;
};

/**
 * A reader of the display pose, and `locking`/`locked` for the owner that changes the lock.
 * `locking` runs before the lock command, so a reading that overlaps the command is dropped.
 * A locked pose becomes the reading for the next second; null (a free rotation or a failed
 * command) makes the reading stale. A read that started before a lock never replaces the
 * reading, and a caller after a lock never shares that read.
 */
export function createDisplayOrientationReader({
  read,
  now = () => performance.now(),
}: DisplayOrientationReaderOptions): {
  reader: DisplayOrientationReader;
  locking(): void;
  locked(pose: ScreenOrientation | null): void;
} {
  let orientation: ScreenOrientation | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  // Each lock starts a new generation; a read only counts for the generation it started in.
  let generation = 0;
  // Lock commands that have started but not yet reported their pose.
  let inFlight = 0;
  let pending: { generation: number; read: Promise<ScreenOrientation | null> } | null = null;

  const refresh = () => {
    if (pending?.generation === generation) return pending.read;
    const readGeneration = generation;
    const startedAt = now();
    const entry = { generation: readGeneration } as {
      generation: number;
      read: Promise<ScreenOrientation | null>;
    };
    pending = entry;
    entry.read = (async () => {
      try {
        const next = await read();
        // A newer `observe()` reading wins over this older one.
        if (readGeneration === generation && inFlight === 0 && startedAt >= readAt)
          orientation = next;
      } catch {
        // Keep the last reading.
      } finally {
        if (readGeneration === generation && startedAt >= readAt) readAt = startedAt;
        if (pending === entry) pending = null;
      }
      return orientation;
    })();
    return entry.read;
  };

  return {
    reader: {
      async observe() {
        if (inFlight > 0) return null;
        const readGeneration = generation;
        const startedAt = now();
        let next: ScreenOrientation;
        try {
          next = await read();
        } catch {
          return null;
        }
        if (readGeneration !== generation || inFlight > 0) return null;
        if (startedAt >= readAt) {
          orientation = next;
          readAt = startedAt;
        }
        return { orientation: next, generation: readGeneration };
      },
      current() {
        if (now() - readAt > MAX_AGE_MS) void refresh();
        return orientation;
      },
      async fresh() {
        if (now() - readAt <= MAX_AGE_MS) return orientation;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<ScreenOrientation | null>((resolve) => {
          timer = setTimeout(() => resolve(orientation), FRESH_WAIT_MS);
        });
        try {
          return await Promise.race([refresh(), timeout]);
        } finally {
          clearTimeout(timer);
        }
      },
    },
    locking() {
      generation++;
      inFlight++;
    },
    locked(pose) {
      generation++;
      inFlight = Math.max(0, inFlight - 1);
      if (pose) {
        orientation = pose;
        readAt = now();
      } else {
        readAt = Number.NEGATIVE_INFINITY;
      }
    },
  };
}
