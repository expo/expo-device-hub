import {
  getDeviceSize,
  getDisplayRotation,
  screenOrientationForRotation,
  type DisplayRotation,
  type ScreenOrientation,
} from "./adb.ts";

const MAX_AGE_MS = 1_000;

export type DisplayOrientationReader = {
  /**
   * The last reading, or null before the first one. Starts a new reading in the background
   * when this one is older than a second, so `/api` stays synchronous and cheap.
   */
  current(): ScreenOrientation | null;
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
    readNaturalSize = (target) => getDeviceSize(target),
    now = () => performance.now(),
  }: DisplayOrientationReaderOptions = {},
): DisplayOrientationReader {
  let orientation: ScreenOrientation | null = null;
  let readAt = Number.NEGATIVE_INFINITY;
  let natural: Promise<{ width: number; height: number }> | null = null;
  let pending: Promise<ScreenOrientation | null> | null = null;

  const refresh = () => {
    if (pending) return pending;
    const startedAt = now();
    pending = (async () => {
      try {
        // The natural size never changes while the device runs.
        natural ??= readNaturalSize(serial);
        const [size, rotation] = await Promise.all([natural, readRotation(serial)]);
        orientation = screenOrientationForRotation(rotation, size);
      } catch {
        natural = null;
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
