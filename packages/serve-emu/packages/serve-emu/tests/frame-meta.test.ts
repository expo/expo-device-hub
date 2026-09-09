import { describe, expect, test } from "bun:test";
import {
  FRAME_FLAG_KEY,
  FRAME_META_HEADER_BYTES,
  FRAME_META_MAGIC,
  FRAME_META_V1_HEADER_BYTES,
  parseFramePacket,
  writeFrameMetaHeader,
} from "../src/shared/frame-meta.ts";
import {
  PROTOCOL_GOLDEN_HEX,
  goldenBytes,
} from "./fixtures/protocol-golden.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function withPayload(header: Uint8Array, payload: Uint8Array): Uint8Array {
  const packet = new Uint8Array(header.length + payload.length);
  packet.set(header);
  packet.set(payload, header.length);
  return packet;
}

function packetWithHeader(
  meta: { isKey: boolean; pts: bigint; serverTsMs: number },
  payload: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(FRAME_META_HEADER_BYTES + payload.length);
  writeFrameMetaHeader(out, meta);
  out.set(payload, FRAME_META_HEADER_BYTES);
  return out;
}

describe("frame-meta wire format", () => {
  test("parses the exact documented SEMU v1 header", () => {
    const payload = Uint8Array.from([0, 0, 0, 1, 0x65]);
    const parsed = parseFramePacket(
      withPayload(goldenBytes("semu-v1"), payload),
    );
    expect(parsed).toEqual({
      data: payload,
      isKey: true,
      timestamp: 42,
      serverTsMs: null,
    });
  });

  test("writes and parses the exact documented SEMU v2 header", () => {
    const header = new Uint8Array(FRAME_META_HEADER_BYTES);
    writeFrameMetaHeader(header, {
      isKey: true,
      pts: 42n,
      serverTsMs: 1_000,
    });
    expect(hex(header)).toBe(PROTOCOL_GOLDEN_HEX["semu-v2"]);

    const payload = Uint8Array.from([0, 0, 0, 1, 0x65]);
    expect(parseFramePacket(withPayload(header, payload))).toEqual({
      data: payload,
      isKey: true,
      timestamp: 42,
      serverTsMs: 1_000,
    });
  });

  test("v2 header round-trips key frame fields and payload", () => {
    const payload = Uint8Array.from([0, 0, 0, 1, 0x65, 1, 2, 3]);
    const serverTsMs = 1_750_000_000_123.456;
    const packet = packetWithHeader({ isKey: true, pts: 123_456_789n, serverTsMs }, payload);

    const parsed = parseFramePacket(packet);
    expect(parsed.isKey).toBe(true);
    expect(parsed.timestamp).toBe(123_456_789);
    expect(parsed.serverTsMs).toBeCloseTo(serverTsMs, 3);
    expect(Array.from(parsed.data)).toEqual(Array.from(payload));
  });

  test("v2 header round-trips delta frames", () => {
    const packet = packetWithHeader({ isKey: false, pts: 42n, serverTsMs: 5 }, Uint8Array.from([9]));
    const parsed = parseFramePacket(packet);
    expect(parsed.isKey).toBe(false);
    expect(parsed.timestamp).toBe(42);
    expect(parsed.serverTsMs).toBe(5);
  });

  test("accepts ArrayBuffer input like a WebSocket binary message", () => {
    const packet = packetWithHeader({ isKey: true, pts: 7n, serverTsMs: 1 }, Uint8Array.from([1, 2]));
    const buffer = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength);
    const parsed = parseFramePacket(buffer as ArrayBuffer);
    expect(parsed.isKey).toBe(true);
    expect(Array.from(parsed.data)).toEqual([1, 2]);
  });

  test("parses packets that sit at a non-zero offset in their buffer", () => {
    const packet = packetWithHeader({ isKey: true, pts: 9n, serverTsMs: 1234.5 }, Uint8Array.from([1, 2, 3, 4]));
    const padded = new Uint8Array(packet.length + 5);
    padded.set(packet, 5);
    const parsed = parseFramePacket(padded.subarray(5));
    expect(parsed.isKey).toBe(true);
    expect(parsed.serverTsMs).toBeCloseTo(1234.5, 3);
    expect(Array.from(parsed.data)).toEqual([1, 2, 3, 4]);
  });

  test("pts beyond Number range maps timestamp to null", () => {
    const packet = packetWithHeader({ isKey: false, pts: 1n << 60n, serverTsMs: 0 }, Uint8Array.from([1]));
    expect(parseFramePacket(packet).timestamp).toBeNull();
  });

  test("v1 header parses without server timestamp", () => {
    const payload = Uint8Array.from([7, 8, 9]);
    const packet = new Uint8Array(FRAME_META_V1_HEADER_BYTES + payload.length);
    const view = new DataView(packet.buffer);
    view.setUint32(0, FRAME_META_MAGIC, false);
    view.setUint8(4, 1);
    view.setUint8(5, FRAME_FLAG_KEY);
    view.setBigUint64(8, 77n, false);
    packet.set(payload, FRAME_META_V1_HEADER_BYTES);

    const parsed = parseFramePacket(packet);
    expect(parsed.isKey).toBe(true);
    expect(parsed.timestamp).toBe(77);
    expect(parsed.serverTsMs).toBeNull();
    expect(Array.from(parsed.data)).toEqual([7, 8, 9]);
  });

  test("raw Annex-B data without the magic passes through untouched", () => {
    const raw = Uint8Array.from([0, 0, 0, 1, 0x67, ...Array(20).fill(0xaa)]);
    const parsed = parseFramePacket(raw);
    expect(parsed.isKey).toBeNull();
    expect(parsed.timestamp).toBeNull();
    expect(parsed.serverTsMs).toBeNull();
    expect(parsed.data).toBe(raw);
  });
});
