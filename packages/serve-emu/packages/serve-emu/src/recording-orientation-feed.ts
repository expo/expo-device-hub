import type { ScreenOrientation } from "./shared/api-contracts.ts";

/**
 * How often a recording reads the shown orientation when no event arrives. The event stream is
 * the fast path; this read only bounds the delay when the stream misses a turn.
 */
export const ORIENTATION_READ_MS = 1_000;

/**
 * How often it reads while Android shows an activity turned before the display, so that the
 * timeline sees the display follow, or the turn end without one.
 */
export const SETTLING_READ_MS = 100;

/** How long the feed waits before it opens an event stream that ended. */
export const CHANGE_STREAM_RETRY_MS = 1_000;

/** One reading of the pose that the screen shows. */
export type OrientationReading = {
  orientation: ScreenOrientation;
  /** True while Android shows an activity turned before the display turns. */
  settling?: boolean;
};

export type RecordingOrientationFeedOptions = {
  /**
   * The pose that the screen shows now, from Android's state. Never a requested pose: a lock
   * that the top app refuses, such as the launcher's portrait, does not turn it.
   */
  read(): Promise<OrientationReading>;
  /**
   * Calls `onChange` for each device event after which the shown pose can change, until
   * `signal` aborts, and settles when the stream ends.
   */
  watchChanges(onChange: () => void, signal: AbortSignal): Promise<void>;
  observe(orientation: ScreenOrientation): void;
  /** False once the recording ends; the feed then stops, with its event stream. */
  active(): boolean;
  /** For tests: replaces {@link ORIENTATION_READ_MS}. */
  readIntervalMs?: number;
  /** For tests: replaces {@link SETTLING_READ_MS}. */
  settlingIntervalMs?: number;
  /** For tests: replaces {@link CHANGE_STREAM_RETRY_MS}. */
  retryMs?: number;
};

export type RecordingOrientationFeed = {
  /** Reads now, for a turn that the feed may not have seen yet, such as a Hub rotation. */
  readNow(): void;
  stop(): void;
};

// @ref LLP 0018#orientation-readings — the timeline names the pose the screen shows, not a request
/**
 * Reads the shown orientation while a recording runs: at once, after each device event that can
 * turn it, when the caller asks, every 100 ms while an activity is turned before the display,
 * and each second as a fallback. One read runs at a time; an event during a read reads again
 * when it ends, because that read may have started before the turn.
 */
export function startRecordingOrientationFeed(
  options: RecordingOrientationFeedOptions,
): RecordingOrientationFeed {
  const readIntervalMs = options.readIntervalMs ?? ORIENTATION_READ_MS;
  const settlingIntervalMs = options.settlingIntervalMs ?? SETTLING_READ_MS;
  const retryMs = options.retryMs ?? CHANGE_STREAM_RETRY_MS;
  const lifetime = new AbortController();
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  let readAgain = false;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    lifetime.abort();
    if (readTimer) clearTimeout(readTimer);
    if (retryTimer) clearTimeout(retryTimer);
    readTimer = null;
    retryTimer = null;
  };

  /** False once the feed has stopped. A recording that ended stops it. */
  const running = () => {
    if (stopped) return false;
    if (options.active()) return true;
    stop();
    return false;
  };

  const read = () => {
    if (readTimer) clearTimeout(readTimer);
    readTimer = null;
    if (!running()) return;
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    let settling = false;
    void options
      .read()
      .then((shown) => {
        settling = shown.settling === true;
        if (running()) options.observe(shown.orientation);
      })
      // A failed read keeps the last reading.
      .catch(() => {})
      .finally(() => {
        reading = false;
        // A read or a timer is always pending until the feed stops, so it sees the end.
        if (!running()) return;
        if (readAgain) {
          readAgain = false;
          read();
          return;
        }
        readTimer = setTimeout(read, settling ? settlingIntervalMs : readIntervalMs);
        readTimer.unref?.();
      });
  };

  const watch = () => {
    retryTimer = null;
    if (!running()) return;
    void options
      .watchChanges(read, lifetime.signal)
      .catch(() => {})
      .finally(() => {
        // The fallback read covers the gap until the stream opens again.
        if (!running()) return;
        retryTimer = setTimeout(watch, retryMs);
        retryTimer.unref?.();
      });
  };

  watch();
  read();
  return { readNow: read, stop };
}
