/**
 * H.264 helpers for the serve-emu (Android) video path. Ported from serve-emu's
 * web UI (`src/ui/lib/h264.ts` + the frame-meta parsing in `use-stream.ts`) so
 * Expo Hub can decode the same `/ws?frame-meta=1` stream with WebCodecs.
 */

/** Build the WebCodecs `avc1.PPCCLL` codec string from an SPS NAL's first bytes. */
export function buildCodecString(spsHeaderAndPayload: Uint8Array): string {
  const profile = spsHeaderAndPayload[1].toString(16).padStart(2, '0');
  const constraints = spsHeaderAndPayload[2].toString(16).padStart(2, '0');
  const level = spsHeaderAndPayload[3].toString(16).padStart(2, '0');
  return `avc1.${profile}${constraints}${level}`;
}

export interface ScanResult {
  isKey: boolean;
  spsBytes: Uint8Array | null;
}

/** Walk an Annex-B access unit to find whether it's a keyframe and grab its SPS. */
export function scanAU(buf: Uint8Array): ScanResult {
  let isKey = false;
  let spsBytes: Uint8Array | null = null;
  const len = buf.length;
  let i = 0;
  while (i + 2 < len) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      let codeLen = 0;
      if (buf[i + 2] === 1) codeLen = 3;
      else if (i + 3 < len && buf[i + 2] === 0 && buf[i + 3] === 1) codeLen = 4;
      if (codeLen) {
        const headerByte = buf[i + codeLen];
        const nalType = headerByte & 0x1f;
        if (nalType === 7 && !spsBytes) spsBytes = buf.subarray(i + codeLen);
        if (nalType === 5) isKey = true;
        i += codeLen + 1;
        continue;
      }
    }
    i++;
  }
  return { isKey, spsBytes };
}

// serve-emu prefixes each WS frame with a 16-byte "SEMU" header carrying the
// keyframe flag + presentation timestamp (see server.ts `withFrameMeta`).
const FRAME_META_MAGIC = 0x53454d55; // "SEMU"
const FRAME_META_VERSION = 1;
const FRAME_META_HEADER_BYTES = 16;
const FRAME_FLAG_KEY = 1 << 0;

export interface FramePacket {
  data: Uint8Array;
  isKey: boolean | null;
  timestamp: number | null;
}

/** Split a `/ws?frame-meta=1` binary message into its meta + Annex-B payload. */
export function parseFramePacket(raw: ArrayBuffer | Uint8Array): FramePacket {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (bytes.byteLength > FRAME_META_HEADER_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, FRAME_META_HEADER_BYTES);
    if (view.getUint32(0, false) === FRAME_META_MAGIC && view.getUint8(4) === FRAME_META_VERSION) {
      const pts = view.getBigUint64(8, false);
      return {
        data: bytes.subarray(FRAME_META_HEADER_BYTES),
        isKey: (view.getUint8(5) & FRAME_FLAG_KEY) !== 0,
        timestamp: pts <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pts) : null,
      };
    }
  }
  return { data: bytes, isKey: null, timestamp: null };
}

export function isWebCodecsSupported(): boolean {
  return typeof globalThis !== 'undefined' && 'VideoDecoder' in globalThis && 'EncodedVideoChunk' in globalThis;
}
