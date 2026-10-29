import {
  getDeviceSize,
  getDisplayRotation,
  screenOrientationForRotation,
  type DisplayRotation,
} from "./adb.ts";
import type { ScreenOrientation } from "./shared/api-contracts.ts";

const MAX_AGE_MS = 1_000;
const FRESH_WAIT_MS = 300;

export type DisplayOrientationReader = {
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
  /** Read now. Concurrent calls share one adb query; a failure keeps the last reading. */
  refresh(): Promise<ScreenOrientation | null>;
};

export type DisplayOrientationReaderOptions = {
  readRotation?: (serial: string) => Promise<DisplayRotation>;
  readNaturalSize?: (serial: string) => Promise<{ width: number; height: number }>;
  now?: () => number;
};

export function createDisplayOrientationReader(
  serial: string,
  {
    readRotation = (target) => getDisplayRotation(target),
    readNaturalSize = (target) => getDeviceSize(target, undefined, "background"),
    now = () => performance.now(),
  }: DisplayOrientationReaderOptions = {},
): DisplayOrientationReader {
  let orientation: ScreenOrientation | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let pending: Promise<ScreenOrientation | null> | null = null;

  const refresh = () => {
    if (pending) return pending;
    const startedAt = now();
    pending = (async () => {
      try {
        // Read the natural size with each rotation: another AVD can reuse the serial, and a
        // foldable changes its display.
        const [size, rotation] = await Promise.all([readNaturalSize(serial), readRotation(serial)]);
        orientation = screenOrientationForRotation(rotation, size);
      } catch {
        // Keep the last reading.
      } finally {
        readAt = startedAt;
        pending = null;
      }
      return orientation;
    })();
    return pending;
  };

  return {
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
    refresh,
  };
}

const readers = new Map<string, DisplayOrientationReader>();

/** One shared reader per device serial, for the standalone server and the middleware. */
export function displayOrientationReader(serial: string): DisplayOrientationReader {
  let reader = readers.get(serial);
  if (!reader) {
    reader = createDisplayOrientationReader(serial);
    readers.set(serial, reader);
  }
  return reader;
}
