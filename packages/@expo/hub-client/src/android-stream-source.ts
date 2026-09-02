import {
  type DeviceGrpcImageMode,
  type DeviceStreamSource,
  type DeviceStreamSourceStatus,
} from './types';

const ANDROID_STREAM_SOURCES = [
  'scrcpy',
  'grpc-screenshot',
] as const satisfies readonly DeviceStreamSource[];

function isAndroidStreamSource(value: unknown): value is DeviceStreamSource {
  return ANDROID_STREAM_SOURCES.some((source) => source === value);
}

function isGrpcImageMode(value: unknown): value is DeviceGrpcImageMode {
  return value === 'png' || value === 'mmap';
}

/** Parse serve-emu's authoritative device-scoped `/api/stream-mode` response. */
export function parseAndroidStreamSource(value: unknown): DeviceStreamSourceStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.ok !== true ||
    !isAndroidStreamSource(candidate.mode) ||
    !isGrpcImageMode(candidate.grpcImageMode)
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.availableModes) ||
    candidate.availableModes.length === 0 ||
    !candidate.availableModes.every(isAndroidStreamSource) ||
    new Set(candidate.availableModes).size !== candidate.availableModes.length ||
    !candidate.availableModes.includes(candidate.mode)
  ) {
    return null;
  }
  if (
    typeof candidate.sessionGeneration !== 'number' ||
    !Number.isInteger(candidate.sessionGeneration) ||
    candidate.sessionGeneration < 0
  ) {
    return null;
  }
  return {
    mode: candidate.mode,
    grpcImageMode: candidate.grpcImageMode,
    availableModes: candidate.availableModes,
    sessionGeneration: candidate.sessionGeneration,
  };
}
