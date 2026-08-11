/**
 * Wire parser for serve-sim's `/stream.avcc` H.264 stream.
 *
 * Each envelope is `[length:u32-be][tag:u8][payload...]`, where `length`
 * includes the tag byte. The parser keeps incomplete envelopes between reads
 * because a single video frame is commonly split across network chunks.
 */

export const AVCC_TAG_DESCRIPTION = 0x01;
export const AVCC_TAG_KEYFRAME = 0x02;
export const AVCC_TAG_DELTA = 0x03;
export const AVCC_TAG_SEED = 0x04;

export type AvccChunkType = "description" | "keyframe" | "delta" | "seed";

export interface AvccChunk {
  type: AvccChunkType;
  payload: Uint8Array;
}

const TAG_TO_TYPE: Record<number, AvccChunkType | undefined> = {
  [AVCC_TAG_DESCRIPTION]: "description",
  [AVCC_TAG_KEYFRAME]: "keyframe",
  [AVCC_TAG_DELTA]: "delta",
  [AVCC_TAG_SEED]: "seed",
};

export class AvccDemuxer {
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;
  private start = 0;

  private append(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.buffer.length) {
      if (this.start > 0) {
        this.buffer.copyWithin(0, this.start, this.length);
        this.length -= this.start;
        this.start = 0;
      }
      if (this.length + bytes.length > this.buffer.length) {
        let capacity = this.buffer.length;
        while (capacity < this.length + bytes.length) capacity *= 2;
        const grown = new Uint8Array(capacity);
        grown.set(this.buffer.subarray(0, this.length));
        this.buffer = grown;
      }
    }
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  push(bytes: Uint8Array): AvccChunk[] {
    if (bytes.length > 0) this.append(bytes);

    const chunks: AvccChunk[] = [];
    const buffer = this.buffer;
    while (this.length - this.start >= 4) {
      const offset = this.start;
      const length =
        ((buffer[offset]! << 24) |
          (buffer[offset + 1]! << 16) |
          (buffer[offset + 2]! << 8) |
          buffer[offset + 3]!) >>>
        0;
      if (this.length - offset - 4 < length) break;
      if (length < 1) {
        this.start += 4;
        continue;
      }
      const type = TAG_TO_TYPE[buffer[offset + 4]!];
      if (type) {
        chunks.push({ type, payload: buffer.slice(offset + 5, offset + 4 + length) });
      }
      this.start += 4 + length;
    }

    if (this.start > 0) {
      if (this.start < this.length) this.buffer.copyWithin(0, this.start, this.length);
      this.length -= this.start;
      this.start = 0;
    }
    return chunks;
  }

  reset(): void {
    this.length = 0;
    this.start = 0;
  }
}

/** Build an `avc1.PPCCLL` WebCodecs string from an avcC description. */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1.42E01E";
  const hex = (byte: number) => byte.toString(16).padStart(2, "0");
  return `avc1.${hex(description[1]!)}${hex(description[2]!)}${hex(description[3]!)}`;
}

export function isAvccSupported(): boolean {
  return (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as typeof globalThis & { VideoDecoder?: unknown }).VideoDecoder !==
      "undefined"
  );
}
