import { describe, expect, test } from "bun:test";
import { buildCodecString, scanAU } from "../src/ui/lib/h264.ts";

describe("H.264 access-unit helpers", () => {
  test("builds an AVC codec string from the SPS profile bytes", () => {
    expect(buildCodecString(Uint8Array.of(0x67, 0x64, 0x00, 0x29))).toBe(
      "avc1.640029",
    );
    expect(buildCodecString(Uint8Array.of(0x67, 0x4d, 0x40, 0x1f))).toBe(
      "avc1.4d401f",
    );
  });

  test("detects SPS and IDR NAL units with mixed Annex-B start codes", () => {
    const accessUnit = Uint8Array.of(
      0,
      0,
      0,
      1,
      0x67,
      0x64,
      0,
      0x29,
      0,
      0,
      1,
      0x68,
      0xaa,
      0,
      0,
      1,
      0x65,
      0xbb,
    );

    const result = scanAU(accessUnit);

    expect(result.isKey).toBe(true);
    expect(result.spsBytes).not.toBeNull();
    expect(Array.from(result.spsBytes!.subarray(0, 4))).toEqual([
      0x67,
      0x64,
      0,
      0x29,
    ]);
  });

  test("keeps the first SPS and distinguishes non-IDR access units", () => {
    const accessUnit = Uint8Array.of(
      9,
      0,
      0,
      1,
      0x67,
      0x42,
      0,
      0x1e,
      0,
      0,
      0,
      1,
      0x67,
      0x64,
      0,
      0x29,
      0,
      0,
      1,
      0x41,
      1,
    );

    const result = scanAU(accessUnit);

    expect(result.isKey).toBe(false);
    expect(Array.from(result.spsBytes!.subarray(0, 4))).toEqual([
      0x67,
      0x42,
      0,
      0x1e,
    ]);
  });

  test("returns an empty result for padding, short, and truncated start codes", () => {
    for (const bytes of [
      Uint8Array.of(),
      Uint8Array.of(0, 0),
      Uint8Array.of(1, 2, 3, 4),
      Uint8Array.of(0, 0, 1),
      Uint8Array.of(0, 0, 0, 1),
    ]) {
      expect(scanAU(bytes)).toEqual({ isKey: false, spsBytes: null });
    }
  });
});
