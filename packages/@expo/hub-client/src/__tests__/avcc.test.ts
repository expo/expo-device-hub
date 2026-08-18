import { describe, expect, test } from 'bun:test';

import {
  AVCC_TAG_DELTA,
  AVCC_TAG_DESCRIPTION,
  AVCC_TAG_KEYFRAME,
  AVCC_TAG_SEED,
  AvccDemuxer,
  avcCodecString,
} from '../avcc';

function envelope(tag: number, payload: number[]): Uint8Array {
  const length = payload.length + 1;
  const result = new Uint8Array(4 + length);
  new DataView(result.buffer).setUint32(0, length, false);
  result[4] = tag;
  result.set(payload, 5);
  return result;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

describe('AvccDemuxer', () => {
  test('parses complete envelopes in order', () => {
    const chunks = new AvccDemuxer().push(
      concat(
        envelope(AVCC_TAG_DESCRIPTION, [1, 100, 0, 40]),
        envelope(AVCC_TAG_KEYFRAME, [9]),
        envelope(AVCC_TAG_DELTA, [8, 7]),
        envelope(AVCC_TAG_SEED, [0xff, 0xd8, 0xff, 0xd9]),
      ),
    );
    expect(chunks.map((chunk) => chunk.type)).toEqual(['description', 'keyframe', 'delta', 'seed']);
  });

  test('buffers envelopes split across reads', () => {
    const demuxer = new AvccDemuxer();
    const frame = envelope(AVCC_TAG_KEYFRAME, [1, 2, 3, 4]);
    expect(demuxer.push(frame.slice(0, 6))).toHaveLength(0);
    expect(Array.from(demuxer.push(frame.slice(6))[0]!.payload)).toEqual([1, 2, 3, 4]);
  });

  test('reset drops a partial envelope', () => {
    const demuxer = new AvccDemuxer();
    demuxer.push(envelope(AVCC_TAG_DELTA, [1, 2]).slice(0, 4));
    demuxer.reset();
    expect(demuxer.push(envelope(AVCC_TAG_KEYFRAME, [9]))[0]!.type).toBe('keyframe');
  });
});

describe('avcCodecString', () => {
  test('derives profile, constraints, and level from avcC', () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0, 0x28, 0xff]))).toBe('avc1.640028');
  });
});
