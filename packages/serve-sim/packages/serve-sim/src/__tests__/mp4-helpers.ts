import { readFileSync } from "fs";

/** The parts of an MP4 the recording tests check, read from the box tree without a decoder. */
export interface Mp4Summary {
  width: number;
  height: number;
  /** Video samples in the first video track. */
  samples: number;
  /** Track duration in seconds, from the media header. */
  durationSeconds: number;
  codec: string;
}

function boxes(buffer: Buffer, start: number, end: number): Array<{ type: string; start: number; end: number }> {
  const out: Array<{ type: string; start: number; end: number }> = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) break;
    out.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return out;
}

function child(buffer: Buffer, parent: { start: number; end: number }, type: string, skip = 0) {
  return boxes(buffer, parent.start + skip, parent.end).find(b => b.type === type);
}

/** Summarizes the first video track. Throws when the file has none. */
export function summarizeMp4(path: string): Mp4Summary {
  const buffer = readFileSync(path);
  const moov = boxes(buffer, 0, buffer.length).find(b => b.type === "moov");
  if (!moov) throw new Error(`${path}: no moov box`);
  for (const trak of boxes(buffer, moov.start, moov.end).filter(b => b.type === "trak")) {
    const mdia = child(buffer, trak, "mdia");
    if (!mdia) continue;
    const hdlr = child(buffer, mdia, "hdlr");
    if (!hdlr || buffer.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") continue;
    const mdhd = child(buffer, mdia, "mdhd");
    const minf = child(buffer, mdia, "minf");
    const stbl = minf && child(buffer, minf, "stbl");
    const stsd = stbl && child(buffer, stbl, "stsd");
    const stsz = stbl && child(buffer, stbl, "stsz");
    if (!mdhd || !stsd || !stsz) throw new Error(`${path}: incomplete video track`);
    const version = buffer[mdhd.start];
    const timescale = version === 1 ? buffer.readUInt32BE(mdhd.start + 20) : buffer.readUInt32BE(mdhd.start + 12);
    const duration = version === 1 ? Number(buffer.readBigUInt64BE(mdhd.start + 24)) : buffer.readUInt32BE(mdhd.start + 16);
    // stsd: version/flags (4), entry count (4), then the sample entry: size (4), type (4), reserved (6),
    // data reference index (2), then 16 bytes of pre-defined fields, then width and height.
    const entry = stsd.start + 8;
    const codec = buffer.toString("latin1", entry + 4, entry + 8);
    const width = buffer.readUInt16BE(entry + 8 + 6 + 2 + 16);
    const height = buffer.readUInt16BE(entry + 8 + 6 + 2 + 18);
    const sampleSize = buffer.readUInt32BE(stsz.start + 4);
    const samples = buffer.readUInt32BE(stsz.start + 8);
    return { width, height, samples: sampleSize === 0 ? samples : samples, durationSeconds: duration / timescale, codec };
  }
  throw new Error(`${path}: no video track`);
}
