import type { HingeSensor } from "./fold.ts";
import type { RecordingPose } from "./recording-canvas.ts";
import type { ScreenOrientation } from "./shared/api-contracts.ts";

// @ref LLP 0018#hinge-readings — gRPC reads every 100 ms, as serve-sim's hinge monitor updates
/** How often a foldable's recording reads the hinge over the emulator's gRPC controller. */
export const GRPC_HINGE_READ_MS = 100;

/** How often it reads the hinge over adb, two commands a read, until gRPC works. */
export const ADB_HINGE_READ_MS = 1_000;

export type FoldRecordingFeedOptions = {
  /** Opens the hinge over gRPC. Until it opens, and after it fails, the feed reads over adb. */
  openSensor(signal: AbortSignal): Promise<HingeSensor>;
  /** The hinge angle over adb, or null when the device has none. */
  readHingeOverAdb(): Promise<number | null>;
  /** The pose that the UI shows on the panel now, or null before the first reading. */
  orientation(): ScreenOrientation | null;
  observe(pose: RecordingPose): void;
  /** False once the recording ends; the feed then stops reading. */
  active(): boolean;
};

export type FoldRecordingFeed = {
  /** Reads now, for a fold that the feed may not have seen yet. */
  readNow(): void;
  stop(): void;
};

/**
 * Reads the hinge and the orientation while a foldable records, since the hinge also moves
 * through adb, agent-device, or the emulator's own controls. The emulator has no hinge angle
 * stream, so the feed reads the angle and reads it again at once when the emulator pushes a
 * posture change.
 */
export function startFoldRecordingFeed(options: FoldRecordingFeedOptions): FoldRecordingFeed {
  const lifetime = new AbortController();
  let sensor: HingeSensor | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  let readAgain = false;
  let stopped = false;

  const dropSensor = () => {
    sensor?.close();
    sensor = null;
  };

  const readHinge = async (): Promise<number | null> => {
    const current = sensor;
    if (current) {
      try {
        return await current.readAngle(lifetime.signal);
      } catch {
        if (stopped) return null;
        // A failed gRPC read falls back to adb for the rest of the recording.
        if (sensor === current) dropSensor();
      }
    }
    return options.readHingeOverAdb();
  };

  const read = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || !options.active()) return;
    if (reading) {
      // A push during a read can come after the angle that the read returned.
      readAgain = true;
      return;
    }
    reading = true;
    void readHinge()
      .then((hingeAngle) => {
        if (stopped) return;
        const orientation = options.orientation();
        options.observe({
          ...(hingeAngle !== null ? { hingeAngle } : {}),
          ...(orientation !== null ? { orientation } : {}),
        });
      })
      .catch(() => {})
      .finally(() => {
        reading = false;
        if (stopped || !options.active()) return;
        if (readAgain) {
          readAgain = false;
          read();
          return;
        }
        timer = setTimeout(read, sensor ? GRPC_HINGE_READ_MS : ADB_HINGE_READ_MS);
        timer.unref?.();
      });
  };

  void options
    .openSensor(lifetime.signal)
    .then((opened) => {
      if (stopped) {
        opened.close();
        return;
      }
      sensor = opened;
      // A stream that ends leaves the reads on the timer.
      void opened.watchPostures(read, lifetime.signal).catch(() => {});
      read();
    })
    .catch(() => {});

  read();
  return {
    readNow: read,
    stop() {
      if (stopped) return;
      stopped = true;
      lifetime.abort();
      if (timer) clearTimeout(timer);
      timer = null;
      dropSensor();
    },
  };
}
