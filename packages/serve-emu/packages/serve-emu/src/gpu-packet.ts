// @ref LLP 0017#socket-protocol — the GPC1 records the expo-emulator-capture agent writes
/** GPC1 capture socket records; all integers are big-endian. */
export const GPU_HEADER_BYTES = 32;
export const MAX_GPU_PACKET_BYTES = 8 * 1024 * 1024;
const MAX_GPU_DETAILS_BYTES = 4096;

export const GPU_RECORD = {
  frame: 0,
  keyFrame: 1,
  hello: 2,
  configured: 3,
  resized: 4,
} as const;

export type GpuRecord = {
  pts: bigint;
  flags: number;
  width: number;
  height: number;
  fps: number;
  data: Buffer;
};

export class GpuPacketReader {
  #pending: Buffer = Buffer.alloc(0);
  constructor(readonly onRecord: (record: GpuRecord) => void) {}

  push(chunk: Buffer): void {
    if (this.#pending.length + chunk.length > MAX_GPU_PACKET_BYTES * 2)
      throw new Error("GPU stream receive buffer exceeded its limit");
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    while (this.#pending.length >= GPU_HEADER_BYTES) {
      const b = this.#pending;
      if (b.toString("ascii", 0, 4) !== "GPC1") throw new Error("Invalid GPU stream magic");
      const length = b.readUInt32BE(4);
      const flags = b.readUInt32BE(16);
      const width = b.readUInt32BE(20),
        height = b.readUInt32BE(24),
        fps = b.readUInt32BE(28);
      const media = flags === GPU_RECORD.frame || flags === GPU_RECORD.keyFrame;
      const details = flags === GPU_RECORD.hello || flags === GPU_RECORD.configured;
      if (
        length > MAX_GPU_PACKET_BYTES ||
        flags > GPU_RECORD.resized ||
        (media && length === 0) ||
        (details && length > MAX_GPU_DETAILS_BYTES) ||
        (flags === GPU_RECORD.resized && length !== 0) ||
        width < 1 ||
        width > 4096 ||
        height < 1 ||
        height > 4096 ||
        fps < 1 ||
        fps > 120
      )
        throw new Error("Invalid GPU stream header");
      if (b.length < GPU_HEADER_BYTES + length) return;
      const record = {
        pts: b.readBigUInt64BE(8),
        flags,
        width,
        height,
        fps,
        data: Buffer.from(b.subarray(GPU_HEADER_BYTES, GPU_HEADER_BYTES + length)),
      };
      this.#pending = b.subarray(GPU_HEADER_BYTES + length);
      this.onRecord(record);
    }
  }

  end(): void {
    if (this.#pending.length) throw new Error("Truncated GPU stream record");
  }
}

/** The JSON object in a hello or configured record; empty when absent. */
export function parseGpuDetails(data: Buffer): Record<string, unknown> {
  if (data.length === 0) return {};
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("GPU stream details must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Packet boundaries are supplied by the encoder, so no next-AUD lookahead is needed. */
export function splitGpuAccessUnit(data: Buffer): {
  sps: Buffer | null;
  pps: Buffer | null;
  data: Buffer;
  isIdr: boolean;
} {
  const starts: { offset: number; header: number }[] = [];
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const size = data[i + 2] === 1 ? 3 : data[i + 2] === 0 && data[i + 3] === 1 ? 4 : 0;
    if (!size || i + size >= data.length) continue;
    starts.push({ offset: i, header: i + size });
    i += size - 1;
  }
  if (!starts.length || starts[0]!.offset !== 0) throw new Error("GPU packet is not Annex-B H.264");
  let sps: Buffer | null = null,
    pps: Buffer | null = null;
  let isIdr = false,
    hasPicture = false;
  const picture: Buffer[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const nal = data.subarray(start.offset, starts[i + 1]?.offset ?? data.length);
    const type = data[start.header]! & 31;
    if (type === 7) sps = Buffer.from(nal);
    else if (type === 8) pps = Buffer.from(nal);
    else {
      picture.push(nal);
      isIdr ||= type === 5;
      hasPicture ||= type === 1 || type === 5;
    }
  }
  return {
    sps,
    pps,
    data: hasPicture ? Buffer.concat(picture) : Buffer.alloc(0),
    isIdr,
  };
}

export function gpuSettingsCommand(maxSize: number, fps: number, bitRate: number): Buffer {
  if (
    !Number.isInteger(maxSize) ||
    maxSize < 0 ||
    maxSize > 4096 ||
    !Number.isInteger(fps) ||
    fps < 1 ||
    fps > 120 ||
    !Number.isInteger(bitRate) ||
    bitRate < 100_000 ||
    bitRate > 50_000_000
  )
    throw new Error("Invalid GPU stream settings");
  const command = Buffer.alloc(13);
  command[0] = 83; // S
  command.writeUInt32BE(maxSize, 1);
  command.writeUInt32BE(fps, 5);
  command.writeUInt32BE(bitRate, 9);
  return command;
}

/** The first hello `protocol` value whose agent accepts the `R` (rotation) command. */
export const GPU_ROTATION_PROTOCOL = 2;

/** The `R` command: Android's display rotation, 0 to 3 (`Surface.ROTATION_0` to `ROTATION_270`). */
export function gpuRotationCommand(rotation: number): Buffer {
  if (!Number.isInteger(rotation) || rotation < 0 || rotation > 3)
    throw new Error("Invalid display rotation");
  const command = Buffer.alloc(5);
  command[0] = 82; // R
  command.writeUInt32BE(rotation, 1);
  return command;
}
