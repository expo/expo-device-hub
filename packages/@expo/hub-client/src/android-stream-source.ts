import {
  type DeviceGrpcImageMode,
  type DeviceInputSource,
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

/** Prefer serve-emu's actionable failure detail, falling back to the HTTP status. */
export function androidStreamSourceErrorMessage(status: number, value: unknown): string {
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const detail =
    typeof candidate?.error === 'string'
      ? candidate.error.trim()
      : typeof candidate?.message === 'string'
        ? candidate.message.trim()
        : '';
  return detail
    ? `Unable to change stream source: ${detail}`
    : `Unable to change stream source (HTTP ${status}).`;
}

function isGrpcImageMode(value: unknown): value is DeviceGrpcImageMode {
  return value === 'png' || value === 'mmap';
}

function isInputSource(value: unknown): value is DeviceInputSource {
  return value === 'scrcpy' || value === 'grpc';
}

/** Parse serve-emu's authoritative device-scoped `/api/stream-mode` response. */
export function parseAndroidStreamSource(value: unknown): DeviceStreamSourceStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.ok !== true ||
    !isAndroidStreamSource(candidate.mode) ||
    !isGrpcImageMode(candidate.grpcImageMode) ||
    !isInputSource(candidate.inputSource)
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.availableInputSources) ||
    candidate.availableInputSources.length === 0 ||
    !candidate.availableInputSources.every(isInputSource) ||
    new Set(candidate.availableInputSources).size !== candidate.availableInputSources.length ||
    !candidate.availableInputSources.includes(candidate.inputSource)
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
    inputSource: candidate.inputSource,
    availableInputSources: candidate.availableInputSources,
    availableModes: candidate.availableModes,
    sessionGeneration: candidate.sessionGeneration,
  };
}
