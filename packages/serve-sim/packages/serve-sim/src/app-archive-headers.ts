import { TransformStream } from "node:stream/web";

const BLOCK = 512;
const MAX_METADATA_BYTES = 1024 * 1024;
const METADATA_TYPES = new Set([0x78, 0x67, 0x4c, 0x4b, 0x4e]); // PAX, global PAX, GNU names/links.
const ENTRY_TYPES = new Set([0, 0x30, 0x31, 0x32, 0x35]);

function parseTarNumber(field: Uint8Array): number {
  if (field[0] === 0x80) {
    let value = 0n;
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    return Number(value);
  }
  const text = Buffer.from(field).toString("latin1");
  const end = text.indexOf("\0");
  if (end !== -1 && field.subarray(end).some((byte) => byte !== 0 && byte !== 32)) return NaN;
  const match = /^ *([0-7]*) *$/.exec(end === -1 ? text : text.slice(0, end));
  return match ? parseInt(match[1] || "0", 8) : NaN;
}

function paxSize(data: Uint8Array): number | undefined {
  let size: number | undefined;
  for (let offset = 0; offset < data.length; ) {
    const space = data.indexOf(32, offset);
    const digits = Buffer.from(data.subarray(offset, space)).toString("latin1");
    const length = /^[1-9][0-9]*$/.test(digits) ? Number(digits) : NaN;
    if (
      space < offset ||
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > data.length ||
      data[offset + length - 1] !== 10
    )
      throw new Error("App archive contains invalid metadata.");
    const record = new TextDecoder().decode(data.subarray(space + 1, offset + length - 1));
    if (record.indexOf("=") <= 0) throw new Error("App archive contains invalid metadata.");
    if (record.startsWith("size=")) {
      if (!/^size=\d+$/.test(record)) throw new Error("App archive contains invalid metadata.");
      size = Number(record.slice(5));
    }
    offset += length;
  }
  return size;
}

/** multitars skips unsupported entry types and buffers PAX metadata before yielding. */
// @ref LLP 0003#installing-a-simulator-app — reject special entries and bound metadata before parsing
export function appArchiveHeaders(
  maxBytes: number,
  maxEntries: number,
): TransformStream<Uint8Array, Uint8Array> {
  const header = new Uint8Array(BLOCK);
  let used = 0,
    remaining = 0,
    expanded = 0,
    entries = 0,
    ended = false;
  let metadata: Uint8Array | undefined,
    metadataUsed = 0,
    global = false;
  let globalSize: number | undefined, nextSize: number | undefined;
  const sizeWithinLimit = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes)
      throw new Error("App archive exceeds the expanded size limit.");
    return size;
  };
  const finishBody = () => {
    if (metadata) {
      const size = paxSize(metadata);
      if (size !== undefined) {
        sizeWithinLimit(size);
        if (global) globalSize = size;
        nextSize = size;
      }
      metadata = undefined;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      expanded += chunk.length;
      if (expanded > maxBytes + maxEntries * 1024)
        throw new Error("App archive exceeds the expanded size limit.");
      for (let offset = 0; offset < chunk.length && !ended; ) {
        if (remaining) {
          const count = Math.min(remaining, chunk.length - offset);
          if (metadata && metadataUsed < metadata.length) {
            const copied = Math.min(count, metadata.length - metadataUsed);
            metadata.set(chunk.subarray(offset, offset + copied), metadataUsed);
            metadataUsed += copied;
          }
          offset += count;
          remaining -= count;
          if (!remaining) finishBody();
          continue;
        }
        const count = Math.min(BLOCK - used, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + count), used);
        used += count;
        offset += count;
        if (used !== BLOCK) continue;
        used = 0;
        if (header.every((byte) => byte === 0)) {
          ended = true;
          continue;
        }
        const checksum = parseTarNumber(header.subarray(148, 156));
        let sum = 0,
          signed = 0;
        for (let i = 0; i < BLOCK; i++) {
          const byte = i >= 148 && i < 156 ? 32 : header[i]!;
          sum += byte;
          signed += byte > 127 ? byte - 256 : byte;
        }
        if (checksum !== sum && checksum !== signed)
          throw new Error("App archive contains an invalid header.");
        if (++entries > maxEntries) throw new Error("App archive exceeds the expanded size limit.");
        const type = header[156]!;
        const meta = METADATA_TYPES.has(type);
        if (!meta && !ENTRY_TYPES.has(type))
          throw new Error("App archive contains an unsupported entry.");
        const parsed = parseTarNumber(header.subarray(124, 136));
        if (!Number.isFinite(parsed)) throw new Error("App archive contains an invalid header.");
        const declared = sizeWithinLimit(parsed);
        const size = meta ? declared : sizeWithinLimit(nextSize ?? globalSize ?? declared);
        if (meta && size > MAX_METADATA_BYTES)
          throw new Error("App archive metadata exceeds the size limit.");
        if (type === 0x78 || type === 0x67) {
          metadata = new Uint8Array(size);
          metadataUsed = 0;
          global = type === 0x67;
        }
        if (!meta) nextSize = undefined;
        remaining = Math.ceil(size / BLOCK) * BLOCK;
        if (!remaining) finishBody();
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (!ended && (used || remaining)) throw new Error("App archive ended unexpectedly.");
    },
  });
}
