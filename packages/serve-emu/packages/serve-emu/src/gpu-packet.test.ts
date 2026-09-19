import { describe, expect, test } from "bun:test";
import { GpuPacketReader, gpuSettingsCommand, gpuStreamSize, MAX_GPU_PACKET_BYTES, splitGpuAccessUnit, type GpuRecord } from "./gpu-packet.ts";

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

describe("native GPU packet transport", () => {
  test("decodes byte-by-byte fragmentation and preserves a 64-bit timestamp", () => {
    const received: GpuRecord[] = [];
    const reader = new GpuPacketReader(packet => received.push(packet));
    for (const byte of record(idr)) reader.push(Buffer.from([byte]));
    reader.end();
    expect(received).toEqual([{ data: idr, flags: 1, pts: 1234567890123n, width: 720, height: 1280, fps: 60 }]);
  });
  test("delivers a coalesced handshake and picture immediately without next-picture lookahead", () => {
    const received: GpuRecord[] = [];
    const reader = new GpuPacketReader(packet => received.push(packet));
    reader.push(Buffer.concat([record(Buffer.alloc(0), 2, 0n), record(idr)]));
    expect(received.map(packet => packet.flags)).toEqual([2, 1]);
    expect(received[1]!.data).toEqual(idr);
    reader.end();
  });
  test("rejects bad magic, oversized payloads, invalid metadata and partial records", () => {
    const cases = [record(idr), record(idr), record(idr), record(idr), record(idr)];
    cases[0]!.write("NOPE");
    cases[1]!.writeUInt32BE(MAX_GPU_PACKET_BYTES + 1, 4);
    cases[2]!.writeUInt32BE(4, 16);
    cases[3]!.writeUInt32BE(0, 20);
    cases[4]!.writeUInt32BE(121, 28);
    for (const bytes of cases) expect(() => new GpuPacketReader(() => {}).push(bytes)).toThrow();
    const reader = new GpuPacketReader(() => {});
    reader.push(record(idr).subarray(0, 34));
    expect(() => reader.end()).toThrow("Truncated");
    expect(() => new GpuPacketReader(() => {}).push(Buffer.alloc(MAX_GPU_PACKET_BYTES * 2 + 1))).toThrow("limit");
  });
  test("rejects empty pictures and handshakes with payloads", () => {
    for (const bytes of [record(Buffer.alloc(0), 0), record(idr, 2)])
      expect(() => new GpuPacketReader(() => {}).push(bytes)).toThrow("header");
  });
  test("extracts SPS/PPS and preserves the complete IDR access unit", () => {
    const aud = Buffer.from([0, 0, 1, 9, 0xf0]);
    const sei = Buffer.from([0, 0, 1, 6, 5, 0xff]);
    expect(splitGpuAccessUnit(Buffer.concat([aud, sps, pps, sei, idr]))).toEqual({
      sps, pps, data: Buffer.concat([aud, sei, idr]), isIdr: true,
    });
  });
  test("distinguishes config-only and delta packets and rejects non-Annex-B input", () => {
    expect(splitGpuAccessUnit(Buffer.concat([sps, pps])).data.length).toBe(0);
    const delta = Buffer.from([0, 0, 1, 0x41, 0x88]);
    expect(splitGpuAccessUnit(delta)).toEqual({ sps: null, pps: null, data: delta, isIdr: false });
    expect(() => splitGpuAccessUnit(Buffer.from([0, 0, 0, 2, 0x65, 0x88]))).toThrow("Annex-B");
  });
});

describe("experimental stream settings", () => {
  test("preserves native geometry and caps either orientation without upscaling", () => {
    expect(gpuStreamSize(1080, 2424, 0)).toEqual({ width: 1080, height: 2424 });
    expect(gpuStreamSize(1080, 2424, 1212)).toEqual({ width: 540, height: 1212 });
    expect(gpuStreamSize(1080, 2424, 1280)).toEqual({ width: 570, height: 1280 });
    expect(gpuStreamSize(2424, 1080, 1280)).toEqual({ width: 1280, height: 570 });
    expect(gpuStreamSize(1080, 2424, 4096)).toEqual({ width: 1080, height: 2424 });
    for (const maxSize of [-1, 1, 4097, 1.5, NaN]) expect(() => gpuStreamSize(1080, 2424, maxSize)).toThrow();
  });
  test("encodes the private settings request and rejects unsupported values", () => {
    expect(gpuSettingsCommand(1280, 30, 12_000_000).toString("hex")).toBe("53000005000000001e00b71b00");
    for (const fps of [0, 121, 29.5]) expect(() => gpuSettingsCommand(0, fps, 12_000_000)).toThrow();
    expect(() => gpuSettingsCommand(0, 30, 0)).toThrow();
  });
  test("accepts a fragmented settings acknowledgement followed by an IDR", () => {
    const received: GpuRecord[] = [];
    const reader = new GpuPacketReader(packet => received.push(packet));
    const bytes = Buffer.concat([record(Buffer.alloc(0), 2, 0n), record(Buffer.alloc(0), 3, 0n), record(idr)]);
    for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.subarray(i, i + 7));
    reader.end();
    expect(received.map(packet => packet.flags)).toEqual([2, 3, 1]);
    expect(() => new GpuPacketReader(() => {}).push(record(idr, 3))).toThrow();
  });
});
