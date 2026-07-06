import { describe, expect, test } from 'bun:test';

import { codecStringFromSps, FragmentedMp4Muxer } from '../mp4-muxer';

// ── fixtures ────────────────────────────────────────────────────────────────
// Real SPS/PPS captured from `ffmpeg`/scrcpy output and cross-checked with
// `ffprobe` (profile + dimensions). Regenerate with e.g.
//   ffmpeg -f lavfi -i testsrc=size=WxH:rate=30 -frames:v 1 -pix_fmt yuv420p \
//          -c:v libx264 -profile:v <p> -f h264 out.h264
// then read the SPS (NAL type 7) / PPS (type 8) bytes.
function hex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// serve-emu emulator stream: Constrained Baseline, 576×1280, no emulation bytes.
const SPS_576 = hex('6742c0298d680900a1a420202020f08846a0');
const PPS_576 = hex('68ce01a835c8');
// Baseline 1280×720 — SPS carries `00 00 03` emulation-prevention bytes.
const SPS_720 = hex('6742c01fd9005005bb0110000003001000000303c0f1832480');
const PPS_720 = hex('68cb83cb20');
// High profile 1920×1080 — exercises the high-profile SPS branch, frame cropping
// (coded 1088 → cropped to 1080), and `00 00 03` emulation bytes.
const SPS_1080 = hex('67640028acd940780227e5c044000003000400000300f03c60c658');
const PPS_1080 = hex('68ebe3cb22c0');

// Dummy coded slices — the muxer copies NAL bytes verbatim without inspecting the
// slice data, so distinctive placeholders are enough to assert its behavior.
const START = new Uint8Array([0, 0, 0, 1]);
const IDR = new Uint8Array([0x65, 0x88, 0x84, 0x21]); // NAL type 5 (IDR)
const SLICE = new Uint8Array([0x41, 0x9a, 0x13]); // NAL type 1 (non-IDR)

function annexB(...nals: Uint8Array[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const nal of nals) parts.push(START, nal);
  let len = 0;
  for (const p of parts) len += p.byteLength;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

const keyframe = (sps: Uint8Array, pps: Uint8Array, ...tail: Uint8Array[]) =>
  annexB(sps, pps, ...(tail.length ? tail : [IDR]));

// ── ISO-BMFF box walker (test-local, independent of the muxer) ───────────────
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];

interface Box {
  type: string;
  start: number;
  size: number;
  bodyStart: number;
  bodyEnd: number;
}

function topBoxes(b: Uint8Array, start = 0, end = b.byteLength): Box[] {
  const list: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size = u32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const box: Box = { type, start: p, size, bodyStart: p + 8, bodyEnd: p + size };
    if (size < 8 || p + size > end) {
      box.bodyEnd = end;
      list.push(box);
      break;
    }
    list.push(box);
    p += size;
  }
  return list;
}

/** First direct child of a *container* box (children begin at its body start). */
function child(b: Uint8Array, box: Box, type: string): Box | null {
  return topBoxes(b, box.bodyStart, box.bodyEnd).find((x) => x.type === type) ?? null;
}

/** Drill a chain of container boxes, e.g. drill(b, moov, "trak", "mdia", "minf"). */
function drill(b: Uint8Array, box: Box | null, ...types: string[]): Box | null {
  let cur = box;
  for (const t of types) {
    if (!cur) return null;
    cur = child(b, cur, t);
  }
  return cur;
}

/** Locate a box by type anywhere in [start,end) — for boxes nested behind fixed
 *  header fields (stsd's entry list, the avc1 sample entry). */
function scanBox(b: Uint8Array, start: number, end: number, type: string): Box | null {
  for (let p = start; p + 8 <= end; p++) {
    if (
      b[p + 4] === type.charCodeAt(0) &&
      b[p + 5] === type.charCodeAt(1) &&
      b[p + 6] === type.charCodeAt(2) &&
      b[p + 7] === type.charCodeAt(3)
    ) {
      const size = u32(b, p);
      if (size >= 8 && p + size <= end) return { type, start: p, size, bodyStart: p + 8, bodyEnd: p + size };
    }
  }
  return null;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('codecStringFromSps', () => {
  test('formats avc1.PPCCLL from the SPS profile/constraint/level bytes', () => {
    expect(codecStringFromSps(SPS_576)).toBe('avc1.42c029');
    expect(codecStringFromSps(SPS_720)).toBe('avc1.42c01f');
    expect(codecStringFromSps(SPS_1080)).toBe('avc1.640028');
  });
});

describe('SPS dimension parsing', () => {
  const vectors: {
    label: string;
    sps: Uint8Array;
    pps: Uint8Array;
    width: number;
    height: number;
    codec: string;
  }[] = [
    { label: 'baseline 576×1280', sps: SPS_576, pps: PPS_576, width: 576, height: 1280, codec: 'avc1.42c029' },
    { label: 'baseline 1280×720 (emulation bytes)', sps: SPS_720, pps: PPS_720, width: 1280, height: 720, codec: 'avc1.42c01f' }, // prettier-ignore
    { label: 'high 1920×1080 (cropping + emulation)', sps: SPS_1080, pps: PPS_1080, width: 1920, height: 1080, codec: 'avc1.640028' }, // prettier-ignore
  ];
  for (const { label, sps, pps, width, height, codec } of vectors) {
    test(label, () => {
      const mux = new FragmentedMp4Muxer();
      mux.append(keyframe(sps, pps), true, 0);
      expect(mux.dimensions).toEqual({ width, height });
      expect(mux.codec).toBe(codec);
    });
  }
});

describe('lifecycle', () => {
  test('is not ready and emits nothing until the first keyframe with SPS/PPS', () => {
    const mux = new FragmentedMp4Muxer();
    const before = mux.append(annexB(SLICE), false, 0);
    expect(mux.ready).toBe(false);
    expect(before.init).toBeUndefined();
    expect(before.segment).toBeUndefined();

    const first = mux.append(keyframe(SPS_576, PPS_576), true, 0);
    expect(mux.ready).toBe(true);
    expect(first.init).toBeInstanceOf(Uint8Array);
    expect(first.segment).toBeInstanceOf(Uint8Array);
  });

  test('emits the init segment once for an unchanged codec config', () => {
    const mux = new FragmentedMp4Muxer();
    expect(mux.append(keyframe(SPS_576, PPS_576), true, 0).init).toBeInstanceOf(Uint8Array);
    expect(mux.append(annexB(SLICE), false, 3000).init).toBeUndefined();
    // A repeated keyframe with the same SPS/PPS must not re-emit init.
    expect(mux.append(keyframe(SPS_576, PPS_576), true, 6000).init).toBeUndefined();
  });

  test('re-emits init and updates dimensions when the codec config changes', () => {
    const mux = new FragmentedMp4Muxer();
    mux.append(keyframe(SPS_576, PPS_576), true, 0);
    expect(mux.dimensions).toEqual({ width: 576, height: 1280 });

    const changed = mux.append(keyframe(SPS_720, PPS_720), true, 3000);
    expect(changed.init).toBeInstanceOf(Uint8Array);
    expect(mux.dimensions).toEqual({ width: 1280, height: 720 });
  });
});

describe('init segment', () => {
  const mux = new FragmentedMp4Muxer();
  const init = mux.append(keyframe(SPS_576, PPS_576), true, 0).init!;

  test('is ftyp followed by moov', () => {
    const top = topBoxes(init).map((b) => b.type);
    expect(top).toEqual(['ftyp', 'moov']);
  });

  test('moov carries mvhd, trak and mvex→trex', () => {
    const moov = topBoxes(init)[1];
    const kinds = topBoxes(init, moov.bodyStart, moov.bodyEnd).map((b) => b.type);
    expect(kinds).toEqual(['mvhd', 'trak', 'mvex']);
    expect(drill(init, moov, 'mvex', 'trex')).not.toBeNull();
  });

  test('has the trak → mdia → minf → stbl → stsd chain', () => {
    const moov = topBoxes(init)[1];
    expect(drill(init, moov, 'trak', 'mdia', 'minf', 'stbl', 'stsd')).not.toBeNull();
  });

  test('avcC embeds the exact SPS and PPS with a valid config header', () => {
    const avcc = scanBox(init, 0, init.byteLength, 'avcC')!;
    expect(avcc).not.toBeNull();
    const body = init.subarray(avcc.bodyStart, avcc.bodyEnd);
    expect(body[0]).toBe(1); // configurationVersion
    expect(body[1]).toBe(SPS_576[1]); // AVCProfileIndication
    expect(body[3]).toBe(SPS_576[3]); // AVCLevelIndication
    expect(indexOfBytes(body, SPS_576)).toBeGreaterThanOrEqual(0);
    expect(indexOfBytes(body, PPS_576)).toBeGreaterThanOrEqual(0);
  });

  test('avc1 sample entry records the coded width/height', () => {
    const avc1 = scanBox(init, 0, init.byteLength, 'avc1')!;
    expect(avc1).not.toBeNull();
    // width/height are 24/26 bytes into the avc1 sample-entry body.
    expect(u16(init, avc1.bodyStart + 24)).toBe(576);
    expect(u16(init, avc1.bodyStart + 26)).toBe(1280);
  });
});

describe('media segment', () => {
  function trunFields(segment: Uint8Array) {
    const moof = topBoxes(segment)[0];
    const trun = drill(segment, moof, 'traf', 'trun')!;
    return {
      moof,
      sampleCount: u32(segment, trun.start + 12),
      dataOffset: u32(segment, trun.start + 16),
      duration: u32(segment, trun.start + 20),
      size: u32(segment, trun.start + 24),
      flags: u32(segment, trun.start + 28),
    };
  }

  test('is moof followed by mdat', () => {
    const mux = new FragmentedMp4Muxer();
    const seg = mux.append(keyframe(SPS_576, PPS_576), true, 0).segment!;
    expect(topBoxes(seg).map((b) => b.type)).toEqual(['moof', 'mdat']);
  });

  test('moof→traf carries tfhd, tfdt and trun', () => {
    const mux = new FragmentedMp4Muxer();
    const seg = mux.append(keyframe(SPS_576, PPS_576), true, 0).segment!;
    const traf = drill(seg, topBoxes(seg)[0], 'traf')!;
    expect(topBoxes(seg, traf.bodyStart, traf.bodyEnd).map((b) => b.type)).toEqual([
      'tfhd',
      'tfdt',
      'trun',
    ]);
  });

  test('trun sample size equals the mdat payload and data_offset points at it', () => {
    const mux = new FragmentedMp4Muxer();
    const seg = mux.append(keyframe(SPS_576, PPS_576), true, 0).segment!;
    const { moof, sampleCount, dataOffset, size } = trunFields(seg);
    const mdat = topBoxes(seg)[1];
    const mdatPayload = mdat.size - 8;
    expect(sampleCount).toBe(1);
    expect(size).toBe(mdatPayload);
    // data_offset is measured from the moof start to the first mdat payload byte.
    expect(dataOffset).toBe(moof.size + 8);
  });

  test('marks keyframes as sync samples and deltas as non-sync', () => {
    const mux = new FragmentedMp4Muxer();
    const keySeg = mux.append(keyframe(SPS_576, PPS_576), true, 0).segment!;
    const deltaSeg = mux.append(annexB(SLICE), false, 3000).segment!;
    expect(trunFields(keySeg).flags).toBe(0x02000000); // sample_depends_on = 2, sync
    expect(trunFields(deltaSeg).flags).toBe(0x01010000); // depends_on = 1, non-sync
  });
});

describe('NAL handling', () => {
  test('mdat holds length-prefixed AVCC of VCL+SEI NALs, stripping SPS/PPS/AUD', () => {
    const mux = new FragmentedMp4Muxer();
    const aud = new Uint8Array([0x09, 0x10]); // access unit delimiter (type 9) → dropped
    const sei = new Uint8Array([0x06, 0x01, 0x02, 0x03]); // SEI (type 6) → kept
    const idr = new Uint8Array([0x65, 0x11, 0x22]); // IDR (type 5) → kept
    const seg = mux.append(annexB(aud, SPS_576, PPS_576, sei, idr), true, 0).segment!;

    const mdat = topBoxes(seg)[1];
    const body = seg.subarray(mdat.bodyStart, mdat.bodyEnd);

    // Expected: [len][sei][len][idr] — SPS/PPS/AUD excluded.
    expect(body.byteLength).toBe(4 + sei.byteLength + 4 + idr.byteLength);
    expect(u32(body, 0)).toBe(sei.byteLength);
    expect(Array.from(body.subarray(4, 4 + sei.byteLength))).toEqual(Array.from(sei));
    const idrLenAt = 4 + sei.byteLength;
    expect(u32(body, idrLenAt)).toBe(idr.byteLength);
    expect(Array.from(body.subarray(idrLenAt + 4))).toEqual(Array.from(idr));

    // The parameter sets live in avcC, never in the mdat.
    expect(indexOfBytes(body, SPS_576)).toBe(-1);
    expect(indexOfBytes(body, PPS_576)).toBe(-1);
    expect(indexOfBytes(body, aud)).toBe(-1);
  });
});

describe('fragment timeline', () => {
  function baseMediaDecodeTime(segment: Uint8Array): number {
    const tfdt = drill(segment, topBoxes(segment)[0], 'traf', 'tfdt')!;
    expect(segment[tfdt.start + 8]).toBe(1); // version 1 → 64-bit
    expect(u32(segment, tfdt.start + 12)).toBe(0); // high word
    return u32(segment, tfdt.start + 16);
  }
  const mfhdSequence = (segment: Uint8Array) =>
    u32(segment, drill(segment, topBoxes(segment)[0], 'mfhd')!.start + 12);

  test('baseMediaDecodeTime is monotonic and mfhd sequence increments', () => {
    const mux = new FragmentedMp4Muxer();
    const s1 = mux.append(keyframe(SPS_576, PPS_576), true, 0).segment!;
    const s2 = mux.append(annexB(SLICE), false, 3000).segment!;
    const s3 = mux.append(annexB(SLICE), false, 6000).segment!;

    expect(baseMediaDecodeTime(s1)).toBe(0);
    expect(baseMediaDecodeTime(s2)).toBeGreaterThan(baseMediaDecodeTime(s1));
    expect(baseMediaDecodeTime(s3)).toBeGreaterThan(baseMediaDecodeTime(s2));
    expect([s1, s2, s3].map(mfhdSequence)).toEqual([1, 2, 3]);
  });
});
