import { describe, expect, test } from "bun:test";
import {
  GPU_RECORD,
  GpuPacketReader,
  gpuSettingsCommand,
  MAX_GPU_PACKET_BYTES,
  parseGpuDetails,
  splitGpuAccessUnit,
  type GpuRecord,
} from "../src/gpu-packet.ts";

function record(data: Buffer, flags = 1, pts = 1234567890123n): Buffer {
  const header = Buffer.alloc(32);
  header.write("GPC1");
  header.writeUInt32BE(data.length, 4);
  header.writeBigUInt64BE(pts, 8);
  header.writeUInt32BE(flags, 16);
  header.writeUInt32BE(720, 20);
  header.writeUInt32BE(1280, 24);
  header.writeUInt32BE(60, 28);
  return Buffer.concat([header, data]);
}
const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0x20]);
const pps = Buffer.from([0, 0, 1, 0x68, 0xce, 0x3c]);
const idr = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]);
const details = Buffer.from('{"framePath":"gpu"}');

describe("GPU capture socket records", () => {
  test("decodes byte-by-byte fragmentation and preserves a 64-bit timestamp", () => {
    const received: GpuRecord[] = [];
    const reader = new GpuPacketReader((packet) => received.push(packet));
    for (const byte of record(idr)) reader.push(Buffer.from([byte]));
    reader.end();
    expect(received).toEqual([
      { data: idr, flags: 1, pts: 1234567890123n, width: 720, height: 1280, fps: 60 },
    ]);
  });

  test("delivers coalesced handshake, resize, and picture records in order", () => {
    const received: GpuRecord[] = [];
    const reader = new GpuPacketReader((packet) => received.push(packet));
    const bytes = Buffer.concat([
      record(details, GPU_RECORD.hello, 0n),
      record(details, GPU_RECORD.configured, 0n),
      record(Buffer.alloc(0), GPU_RECORD.resized, 0n),
      record(idr),
    ]);
    for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.subarray(i, i + 7));
    reader.end();
    expect(received.map((packet) => packet.flags)).toEqual([2, 3, 4, 1]);
    expect(received[3]!.data).toEqual(idr);
  });

  test("rejects bad magic, oversized payloads, unknown flags, invalid metadata and partial records", () => {
    const cases = [record(idr), record(idr), record(idr), record(idr), record(idr)];
    cases[0]!.write("NOPE");
    cases[1]!.writeUInt32BE(MAX_GPU_PACKET_BYTES + 1, 4);
    cases[2]!.writeUInt32BE(6, 16);
    cases[3]!.writeUInt32BE(0, 20);
    cases[4]!.writeUInt32BE(121, 28);
    for (const bytes of cases) expect(() => new GpuPacketReader(() => {}).push(bytes)).toThrow();
    const reader = new GpuPacketReader(() => {});
    reader.push(record(idr).subarray(0, 34));
    expect(() => reader.end()).toThrow("Truncated");
    expect(() =>
      new GpuPacketReader(() => {}).push(Buffer.alloc(MAX_GPU_PACKET_BYTES * 2 + 1)),
    ).toThrow("limit");
  });

  test("rejects empty pictures, resize and replaced payloads, and oversized details", () => {
    for (const bytes of [
      record(Buffer.alloc(0), GPU_RECORD.frame),
      record(idr, GPU_RECORD.resized),
      record(idr, GPU_RECORD.replaced),
      record(Buffer.alloc(4097, 0x20), GPU_RECORD.hello),
    ])
      expect(() => new GpuPacketReader(() => {}).push(bytes)).toThrow("header");
  });

  test("accepts a replaced record, which has no size or rate", () => {
    const replaced = Buffer.alloc(32);
    replaced.write("GPC1");
    replaced.writeUInt32BE(GPU_RECORD.replaced, 16);
    const received: GpuRecord[] = [];
    new GpuPacketReader((packet) => received.push(packet)).push(replaced);
    expect(received.map((packet) => packet.flags)).toEqual([GPU_RECORD.replaced]);
  });

  test("parses details as a JSON object", () => {
    expect(parseGpuDetails(details)).toEqual({ framePath: "gpu" });
    expect(parseGpuDetails(Buffer.alloc(0))).toEqual({});
    expect(() => parseGpuDetails(Buffer.from("[1]"))).toThrow("JSON object");
    expect(() => parseGpuDetails(Buffer.from("{"))).toThrow();
  });

  test("extracts SPS/PPS and preserves the complete IDR access unit", () => {
    const aud = Buffer.from([0, 0, 1, 9, 0xf0]);
    const sei = Buffer.from([0, 0, 1, 6, 5, 0xff]);
    expect(splitGpuAccessUnit(Buffer.concat([aud, sps, pps, sei, idr]))).toEqual({
      sps,
      pps,
      data: Buffer.concat([aud, sei, idr]),
      isIdr: true,
    });
  });

  test("distinguishes config-only and delta packets and rejects non-Annex-B input", () => {
    expect(splitGpuAccessUnit(Buffer.concat([sps, pps])).data.length).toBe(0);
    const delta = Buffer.from([0, 0, 1, 0x41, 0x88]);
    expect(splitGpuAccessUnit(delta)).toEqual({ sps: null, pps: null, data: delta, isIdr: false });
    expect(() => splitGpuAccessUnit(Buffer.from([0, 0, 0, 2, 0x65, 0x88]))).toThrow("Annex-B");
  });
});

describe("GPU capture settings command", () => {
  test("encodes the settings request and rejects unsupported values", () => {
    expect(gpuSettingsCommand(1280, 30, 12_000_000).toString("hex")).toBe(
      "53000005000000001e00b71b00",
    );
    for (const fps of [0, 121, 29.5])
      expect(() => gpuSettingsCommand(0, fps, 12_000_000)).toThrow();
    expect(() => gpuSettingsCommand(0, 30, 0)).toThrow();
    expect(() => gpuSettingsCommand(4097, 30, 12_000_000)).toThrow();
  });

  test("raises a cap below the agent's minimum to the minimum", () => {
    for (const maxSize of [1, 4, 15])
      expect(gpuSettingsCommand(maxSize, 30, 12_000_000).readUInt32BE(1)).toBe(16);
    expect(gpuSettingsCommand(0, 30, 12_000_000).readUInt32BE(1)).toBe(0);
    expect(gpuSettingsCommand(16, 30, 12_000_000).readUInt32BE(1)).toBe(16);
  });
});
