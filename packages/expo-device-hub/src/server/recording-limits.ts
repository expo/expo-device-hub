export type RecordingLimits = {
  maxFileBytes?: number;
  maxDurationMs?: number;
  minFreeBytes?: number;
};

const LIMIT_VARIABLES = {
  maxFileBytes: {
    name: "EXPO_DEVICE_HUB_RECORDING_MAX_BYTES",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  maxDurationMs: { name: "EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS", min: 1, max: 86_400_000 },
  minFreeBytes: {
    name: "EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES",
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  },
} as const;

/** Reads recording limit overrides. Throws before any disk write, naming the variable to fix. */
export function recordingLimitsFromEnv(env: Record<string, string | undefined>): RecordingLimits {
  const limits: RecordingLimits = {};
  for (const [key, { name, min, max }] of Object.entries(LIMIT_VARIABLES)) {
    const value = env[name];
    if (value === undefined) continue;
    const parsed = value.trim() === "" ? NaN : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(
        `${name} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}.`,
      );
    }
    limits[key as keyof RecordingLimits] = parsed;
  }
  return limits;
}

/** The recording's own encode settings; absent fields keep the defaults. */
export type RecordingEncoding = {
  maxSize?: number;
  fps?: number;
  bitRate?: number;
};

// @ref LLP 0023#hub-options — start options; native size, the display's rate and 8 Mbit/s otherwise
const ENCODING_VARIABLES = {
  maxSize: { name: "EXPO_DEVICE_HUB_RECORDING_MAX_DIMENSION", min: 0, max: 4096 },
  fps: { name: "EXPO_DEVICE_HUB_RECORDING_FPS", min: 1, max: 120 },
  bitRate: { name: "EXPO_DEVICE_HUB_RECORDING_BITRATE", min: 100_000, max: 50_000_000 },
} as const;
/** The smallest longest edge besides 0 (native size), as the capture agent accepts it. */
const MIN_MAX_DIMENSION = 16;

/**
 * Reads the recording's encode settings. They apply when the emulator capture agent records
 * the emulator; a recording of the stream's packets keeps the stream's settings. Throws before
 * any disk write, naming the variable to fix.
 */
export function recordingEncodingFromEnv(
  env: Record<string, string | undefined>,
): RecordingEncoding {
  const encoding: RecordingEncoding = {};
  for (const [key, { name, min, max }] of Object.entries(ENCODING_VARIABLES)) {
    const value = env[name];
    if (value === undefined) continue;
    const parsed = value.trim() === "" ? NaN : Number(value);
    const belowMinimumEdge = key === "maxSize" && parsed > 0 && parsed < MIN_MAX_DIMENSION;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max || belowMinimumEdge) {
      throw new Error(
        key === "maxSize"
          ? `${name} must be 0 (native size) or an integer from ${MIN_MAX_DIMENSION} to ${max}; got ${JSON.stringify(value)}.`
          : `${name} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}.`,
      );
    }
    encoding[key as keyof RecordingEncoding] = parsed;
  }
  return encoding;
}
