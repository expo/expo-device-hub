import type { ScreenOrientation } from "./shared/api-contracts.ts";

const MAX_AGE_MS = 1_000;
const FRESH_WAIT_MS = 300;

export type DisplayOrientationReader = {
  /** Fresh observed state only; never starts a device query or returns a commanded pose. */
  peek(): Readonly<{ orientation: ScreenOrientation }> | null;
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
 * A reader of the display pose, and `locked` for the owner that changes the lock. A locked
 * pose becomes the reading for the next second; null (a free rotation) makes the reading
 * stale. A read that started before a lock never replaces the reading, and a caller after a
 * lock never shares that read.
 */
export function createDisplayOrientationReader({
  read,
  now = () => performance.now(),
}: DisplayOrientationReaderOptions): {
  reader: DisplayOrientationReader;
  locked(pose: ScreenOrientation | null): void;
} {
  let orientation: ScreenOrientation | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let observed: Readonly<{ orientation: ScreenOrientation }> | null = null;
  let observedAt = Number.NEGATIVE_INFINITY;
  // Each lock starts a new generation; a read only counts for the generation it started in.
  let generation = 0;
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
        if (readGeneration === generation) {
          orientation = next;
          observed = { orientation: next };
          observedAt = startedAt;
        }
      } catch {
        // Keep the last reading.
      } finally {
        if (readGeneration === generation) readAt = startedAt;
        if (pending === entry) pending = null;
      }
      return orientation;
    })();
    return entry.read;
  };

  return {
    reader: {
      peek() {
        return now() - observedAt <= MAX_AGE_MS ? observed : null;
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
    locked(pose) {
      generation++;
      observed = null;
      observedAt = Number.NEGATIVE_INFINITY;
      if (pose) {
        orientation = pose;
        readAt = now();
      } else {
        readAt = Number.NEGATIVE_INFINITY;
      }
    },
  };
}
