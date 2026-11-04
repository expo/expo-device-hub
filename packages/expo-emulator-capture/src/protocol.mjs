// GPC1 capture socket protocol (consumer side).
// @ref LLP 0017#socket-protocol — record and command meanings
export const HEADER_BYTES = 32;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const FLAGS = Object.freeze({
  frame: 0,
  keyFrame: 1,
  hello: 2,
  configured: 3,
  resized: 4,
});

/** Splits a byte stream into GPC1 records. Throws on malformed input. */
export class RecordReader {
  #pending = Buffer.alloc(0);

  /** @param {(record: {pts: bigint, flags: number, width: number, height: number, fps: number, payload: Buffer}) => void} onRecord */
  constructor(onRecord) {
    this.onRecord = onRecord;
  }

  push(chunk) {
    if (this.#pending.length + chunk.length > MAX_PAYLOAD_BYTES * 2)
      throw new Error("capture stream receive buffer exceeded its limit");
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    while (this.#pending.length >= HEADER_BYTES) {
      const buffer = this.#pending;
      if (buffer.toString("ascii", 0, 4) !== "GPC1")
        throw new Error("invalid capture stream magic");
      const length = buffer.readUInt32BE(4);
      if (length > MAX_PAYLOAD_BYTES) throw new Error("capture stream record is too large");
      if (buffer.length < HEADER_BYTES + length) return;
      const record = {
        pts: buffer.readBigUInt64BE(8),
        flags: buffer.readUInt32BE(16),
        width: buffer.readUInt32BE(20),
        height: buffer.readUInt32BE(24),
        fps: buffer.readUInt32BE(28),
        payload: buffer.subarray(HEADER_BYTES, HEADER_BYTES + length),
      };
      this.#pending = buffer.subarray(HEADER_BYTES + length);
      this.onRecord(record);
    }
  }
}

/** The 'S' command: longest stream edge (0 = native), FPS, and bit rate. */
export function settingsCommand({ maxSize = 0, fps = 60, bitRate = 12_000_000 } = {}) {
  for (const [name, value, min, max] of [
    ["maxSize", maxSize, 0, 4096],
    ["fps", fps, 1, 120],
    ["bitRate", bitRate, 100_000, 50_000_000],
  ]) {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  const command = Buffer.alloc(13);
  command[0] = 0x53; // S
  command.writeUInt32BE(maxSize, 1);
  command.writeUInt32BE(fps, 5);
  command.writeUInt32BE(bitRate, 9);
  return command;
}

export const KEY_FRAME_COMMAND = Buffer.from("K");
