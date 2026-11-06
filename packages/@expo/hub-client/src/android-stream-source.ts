import {
  type DeviceGrpcImageMode,
  type DeviceGrpcEncoder,
  type DeviceInputSource,
  type DeviceStreamSource,
  type DeviceStreamSourceStatus,
} from "./types";

const ANDROID_STREAM_SOURCES = [
  "scrcpy",
  "grpc-screenshot",
  "emulator-capture",
] as const satisfies readonly DeviceStreamSource[];

function isAndroidStreamSource(value: unknown): value is DeviceStreamSource {
  return ANDROID_STREAM_SOURCES.some((source) => source === value);
}

/** Prefer serve-emu's actionable failure detail, falling back to the HTTP status. */
export function androidStreamSourceErrorMessage(status: number, value: unknown): string {
  const candidate =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const error = candidate?.error;
  const structuredMessage =
    error && typeof error === "object" && !Array.isArray(error) && "message" in error
      ? error.message
      : undefined;
  const detail =
    typeof error === "string"
      ? error.trim()
      : typeof structuredMessage === "string"
        ? structuredMessage.trim()
        : typeof candidate?.message === "string"
          ? candidate.message.trim()
          : "";
  return detail
    ? `Unable to change stream source: ${detail}`
    : `Unable to change stream source (HTTP ${status}).`;
}

function isGrpcImageMode(value: unknown): value is DeviceGrpcImageMode {
  return value === "png" || value === "mmap" || value === "rgb888";
}

function isGrpcEncoder(value: unknown): value is DeviceGrpcEncoder {
  return value === "software" || value === "hardware";
}

function isInputSource(value: unknown): value is DeviceInputSource {
  return value === "scrcpy" || value === "grpc";
}

/** Parse serve-emu's authoritative device-scoped `/api/stream-mode` response. */
export function parseAndroidStreamSource(value: unknown): DeviceStreamSourceStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  // Older serve-emu hosts expose only software encoding and omit these fields.
  const encoder = candidate.encoder === undefined ? "software" : candidate.encoder;
  const encoderName = candidate.encoderName === undefined ? null : candidate.encoderName;
  const availableEncoders =
    candidate.availableEncoders === undefined ? ["software"] : candidate.availableEncoders;
  if (
    candidate.ok !== true ||
    !isAndroidStreamSource(candidate.mode) ||
    !isGrpcImageMode(candidate.grpcImageMode) ||
    !isGrpcEncoder(encoder) ||
    !isInputSource(candidate.inputSource)
  ) {
    return null;
  }
  if (
    (encoderName !== null && (typeof encoderName !== "string" || !encoderName.trim())) ||
    !Array.isArray(availableEncoders) ||
    !availableEncoders.every(isGrpcEncoder) ||
    new Set(availableEncoders).size !== availableEncoders.length ||
    !availableEncoders.includes("software") ||
    (candidate.hardwareEncoderError !== undefined &&
      (typeof candidate.hardwareEncoderError !== "string" ||
        !candidate.hardwareEncoderError.trim()))
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
  const unavailableModes = parseModeTexts(candidate.unavailableModes);
  const modeNotes = parseModeTexts(candidate.modeNotes);
  if (
    typeof candidate.sessionGeneration !== "number" ||
    !Number.isInteger(candidate.sessionGeneration) ||
    candidate.sessionGeneration < 0
  ) {
    return null;
  }
  return {
    mode: candidate.mode,
    ...(typeof candidate.repeatFrameMs === "number" &&
    Number.isFinite(candidate.repeatFrameMs) &&
    candidate.repeatFrameMs >= 0
      ? { repeatFrameMs: candidate.repeatFrameMs }
      : {}),
    grpcImageMode: candidate.grpcImageMode,
    encoder,
    encoderName,
    availableEncoders,
    ...(typeof candidate.hardwareEncoderError === "string"
      ? { hardwareEncoderError: candidate.hardwareEncoderError }
      : {}),
    inputSource: candidate.inputSource,
    availableInputSources: candidate.availableInputSources,
    availableModes: candidate.availableModes,
    ...(unavailableModes ? { unavailableModes } : {}),
    ...(modeNotes ? { modeNotes } : {}),
    sessionGeneration: candidate.sessionGeneration,
  };
}

/**
 * Whether two statuses show the same thing, so a poll can keep the current object and skip a
 * render. Every field that the UI shows counts, the unavailable reasons included.
 */
export function sameAndroidStreamSource(
  current: DeviceStreamSourceStatus | null,
  next: DeviceStreamSourceStatus,
): boolean {
  return (
    current?.mode === next.mode &&
    current.repeatFrameMs === next.repeatFrameMs &&
    current.grpcImageMode === next.grpcImageMode &&
    current.encoder === next.encoder &&
    current.encoderName === next.encoderName &&
    current.availableEncoders.join() === next.availableEncoders.join() &&
    current.hardwareEncoderError === next.hardwareEncoderError &&
    current.inputSource === next.inputSource &&
    current.sessionGeneration === next.sessionGeneration &&
    current.availableModes.join() === next.availableModes.join() &&
    current.availableInputSources.join() === next.availableInputSources.join() &&
    JSON.stringify(current.unavailableModes ?? {}) ===
      JSON.stringify(next.unavailableModes ?? {}) &&
    JSON.stringify(current.modeNotes ?? {}) === JSON.stringify(next.modeNotes ?? {})
  );
}

/** Texts per source; a malformed or unknown entry is dropped, not the whole status. */
function parseModeTexts(value: unknown): Partial<Record<DeviceStreamSource, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const texts: Partial<Record<DeviceStreamSource, string>> = {};
  for (const [mode, text] of Object.entries(value)) {
    if (isAndroidStreamSource(mode) && typeof text === "string" && text.trim()) {
      texts[mode] = text.trim();
    }
  }
  return Object.keys(texts).length ? texts : undefined;
}
