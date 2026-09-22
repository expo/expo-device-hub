export type RecordingLimits = {
  maxFileBytes?: number;
  maxDurationMs?: number;
  minFreeBytes?: number;
};

const LIMIT_VARIABLES = {
  maxFileBytes: { name: 'EXPO_DEVICE_HUB_RECORDING_MAX_BYTES', min: 1, max: Number.MAX_SAFE_INTEGER },
  maxDurationMs: { name: 'EXPO_DEVICE_HUB_RECORDING_MAX_DURATION_MS', min: 1, max: 86_400_000 },
  minFreeBytes: { name: 'EXPO_DEVICE_HUB_RECORDING_MIN_FREE_BYTES', min: 0, max: Number.MAX_SAFE_INTEGER },
} as const;

/** Reads recording limit overrides. Throws before any disk write, naming the variable to fix. */
export function recordingLimitsFromEnv(env: Record<string, string | undefined>): RecordingLimits {
  const limits: RecordingLimits = {};
  for (const [key, { name, min, max }] of Object.entries(LIMIT_VARIABLES)) {
    const value = env[name];
    if (value === undefined) continue;
    const parsed = value.trim() === '' ? NaN : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`${name} must be an integer from ${min} to ${max}; got ${JSON.stringify(value)}.`);
    }
    limits[key as keyof RecordingLimits] = parsed;
  }
  return limits;
}
