import { describe, expect, test } from "bun:test";

import { AVCC_TAG_DESCRIPTION, AVCC_TAG_KEYFRAME, AvccDemuxer, avcCodecString } from "../avcc";

function envelope(tag: number, payload: number[]): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(0, payload.length + 1);
  bytes[4] = tag;
  bytes.set(payload, 5);
  return bytes;
}

describe("AvccDemuxer", () => {
  test("buffers split envelopes and emits complete chunks in order", () => {
    const demuxer = new AvccDemuxer();
    const description = envelope(AVCC_TAG_DESCRIPTION, [1, 0x64, 0, 0x28]);
    const frame = envelope(AVCC_TAG_KEYFRAME, [7, 8, 9]);
    const joined = new Uint8Array(description.length + frame.length);
    joined.set(description);
    joined.set(frame, description.length);

    expect(demuxer.push(joined.subarray(0, 7))).toEqual([]);
    expect(demuxer.push(joined.subarray(7))).toEqual([
      { type: "description", payload: new Uint8Array([1, 0x64, 0, 0x28]) },
      { type: "keyframe", payload: new Uint8Array([7, 8, 9]) },
    ]);
  });

  test("reset drops a partial envelope", () => {
    const demuxer = new AvccDemuxer();
    const frame = envelope(AVCC_TAG_KEYFRAME, [1, 2, 3]);
    demuxer.push(frame.subarray(0, 6));
    demuxer.reset();
    expect(demuxer.push(frame)).toEqual([{ type: "keyframe", payload: new Uint8Array([1, 2, 3]) }]);
  });
});

describe("avcCodecString", () => {
  test("reads profile, constraints, and level from an avcC description", () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0, 0x28]))).toBe("avc1.640028");
  });

  test("returns the baseline codec for a malformed description", () => {
    expect(avcCodecString(new Uint8Array([1, 2, 3]))).toBe("avc1.42E01E");
  });
});
