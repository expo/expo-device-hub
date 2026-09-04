import { type DeviceGrpcVideoCodec } from './types';
import { buildCodecString, scanAU } from './h264';

export type AndroidVideoSession = {
  size: { width: number; height: number };
  codec: DeviceGrpcVideoCodec;
};

export function isDeviceGrpcVideoCodec(value: unknown): value is DeviceGrpcVideoCodec {
  return value === 'h264' || value === 'vp8' || value === 'vp9';
}

/** Parse serve-emu's generation boundary before accepting encoded WebSocket frames. */
export function parseAndroidVideoSession(value: unknown): AndroidVideoSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== 'video-session' ||
    (candidate.codec !== undefined && !isDeviceGrpcVideoCodec(candidate.codec))
  ) {
    return null;
  }
  if (!candidate.size || typeof candidate.size !== 'object' || Array.isArray(candidate.size)) {
    return null;
  }
  const size = candidate.size as Record<string, unknown>;
  if (
    typeof size.width !== 'number' ||
    !Number.isFinite(size.width) ||
    size.width <= 0 ||
    typeof size.height !== 'number' ||
    !Number.isFinite(size.height) ||
    size.height <= 0
  ) {
    return null;
  }
  return {
    size: { width: size.width, height: size.height },
    // Older serve-emu releases emitted H.264 and omitted the codec field.
    codec: candidate.codec ?? 'h264',
  };
}

/** VPx codec strings accepted by WebCodecs; H.264 is derived from its SPS instead. */
export function fixedWebCodecsCodec(codec: DeviceGrpcVideoCodec): string | null {
  if (codec === 'vp8') return 'vp8';
  if (codec === 'vp9') return 'vp09.00.10.08';
  return null;
}

/** Resolve H.264's in-band profile or a VPx codec's fixed WebCodecs identifier. */
export function webCodecsCodec(
  codec: DeviceGrpcVideoCodec,
  h264Sps: Uint8Array | null = null,
): string | null {
  if (codec !== 'h264') return fixedWebCodecsCodec(codec);
  return h264Sps && h264Sps.byteLength >= 4 ? buildCodecString(h264Sps) : null;
}

export function grpcVideoCodecLabel(codec: DeviceGrpcVideoCodec): string {
  if (codec === 'h264') return 'H.264';
  return codec.toUpperCase();
}

/** Report why a codec cannot use the browser's non-WebCodecs fallback. */
export function mseFallbackCodecError(
  codec: DeviceGrpcVideoCodec,
  mseSupported = true,
): string | null {
  if (codec !== 'h264') {
    return `${grpcVideoCodecLabel(codec)} WebSocket video requires WebCodecs.`;
  }
  return mseSupported ? null : 'This browser cannot decode H.264 (WebCodecs unavailable).';
}

export function isWebCodecsUnsupportedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NotSupportedError'
  );
}

class BitReader {
  #offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(bits: number): number | null {
    if (!Number.isSafeInteger(bits) || bits < 0 || bits > 31) return null;
    if (this.#offset + bits > this.bytes.byteLength * 8) return null;
    let value = 0;
    for (let index = 0; index < bits; index++) {
      const position = this.#offset++;
      value = value * 2 + ((this.bytes[position >> 3]! >> (7 - (position & 7))) & 1);
    }
    return value;
  }
}

function isRawVp8KeyFrame(data: Uint8Array): boolean {
  return (
    data.byteLength >= 10 &&
    (data[0]! & 1) === 0 &&
    data[3] === 0x9d &&
    data[4] === 0x01 &&
    data[5] === 0x2a
  );
}

function isRawVp9KeyFrame(data: Uint8Array): boolean {
  const bits = new BitReader(data);
  if (bits.read(2) !== 0b10) return false;
  const profileLow = bits.read(1);
  const profileHigh = bits.read(1);
  if (profileLow === null || profileHigh === null) return false;
  const profile = profileLow | (profileHigh << 1);
  if (profile === 3 && bits.read(1) !== 0) return false;
  if (bits.read(1) !== 0 || bits.read(1) !== 0) return false;
  if (bits.read(1) === null || bits.read(1) === null) return false;
  return bits.read(24) === 0x498342;
}

/** Detect a keyframe when legacy/raw video arrives without SEMU metadata. */
export function isRawVideoKeyFrame(codec: DeviceGrpcVideoCodec, data: Uint8Array): boolean {
  if (codec === 'h264') return scanAU(data).isKey;
  if (codec === 'vp8') return isRawVp8KeyFrame(data);
  return isRawVp9KeyFrame(data);
}

/** SEMU's key bit is authoritative; inspect bytes only for metadata-free frames. */
export function resolveVideoKeyFrame(
  codec: DeviceGrpcVideoCodec,
  metadataKey: boolean | null,
  data: Uint8Array,
): boolean {
  return metadataKey ?? isRawVideoKeyFrame(codec, data);
}
