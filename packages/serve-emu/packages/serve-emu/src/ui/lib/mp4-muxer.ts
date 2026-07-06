/**
 * Minimal fragmented-MP4 muxer: repackages an Annex-B H.264 stream (the same
 * `/ws?frame-meta=1` access units the WebCodecs path decodes) into ISO-BMFF
 * fragments that Media Source Extensions can play.
 *
 * Why: WebCodecs (`VideoDecoder`) is a **secure-context-only** API, so it is
 * unavailable when Hub is opened over a plain-HTTP LAN origin
 * (`http://192.168.x.x:8081`, `isSecureContext === false`). `MediaSource` is
 * *not* gated on secure context and can decode H.264 via a `<video>` element, so
 * this muxer is the fallback decode path for that case. It only re-containerizes
 * (no transcode): NAL units are copied verbatim from Annex-B into length-prefixed
 * AVCC `mdat` payloads, with SPS/PPS lifted into the `avcC` config box.
 *
 * DOM-free on purpose so it can be unit-tested under Node/Bun (validated against
 * ffprobe/ffmpeg) and shared verbatim with `@expo/hub-client`.
 */

// ── byte helpers ────────────────────────────────────────────────────────────

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function u64(n: number): Uint8Array {
  const hi = Math.floor(n / 2 ** 32);
  const lo = n >>> 0;
  return new Uint8Array([...u32(hi), ...u32(lo)]);
}

function str4(s: string): Uint8Array {
  return new Uint8Array([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
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

/** Build an ISO-BMFF box: `[size:u32][type:4][...payload]`. */
function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.byteLength), str4(type), body]);
}

// ── Annex-B parsing ─────────────────────────────────────────────────────────

/** Yield each NAL unit (without its start code) from an Annex-B access unit. */
function* nalUnits(au: Uint8Array): Generator<Uint8Array> {
  const n = au.length;
  const findStart = (from: number): { pos: number; len: number } | null => {
    for (let k = from; k + 2 < n; k++) {
      if (au[k] === 0 && au[k + 1] === 0) {
        if (au[k + 2] === 1) return { pos: k, len: 3 };
        if (k + 3 < n && au[k + 2] === 0 && au[k + 3] === 1) return { pos: k, len: 4 };
      }
    }
    return null;
  };
  let sc = findStart(0);
  while (sc) {
    const start = sc.pos + sc.len;
    const next = findStart(start);
    const end = next ? next.pos : n;
    if (end > start) yield au.subarray(start, end);
    sc = next;
  }
}

/** Strip H.264 emulation-prevention bytes (`00 00 03` → `00 00`) to recover the RBSP. */
function toRbsp(nalBody: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nalBody.length; i++) {
    if (i + 2 < nalBody.length && nalBody[i] === 0 && nalBody[i + 1] === 0 && nalBody[i + 2] === 3) {
      out.push(0, 0);
      i += 2; // skip the 0x03; loop's i++ steps past it
    } else {
      out.push(nalBody[i]);
    }
  }
  return new Uint8Array(out);
}

class BitReader {
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}
  bit(): number {
    const b = this.data[this.pos >> 3] ?? 0;
    const v = (b >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit();
    return v >>> 0;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros++;
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) >> 1 : -(k >> 1);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

function skipScalingList(r: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let j = 0; j < size; j++) {
    if (nextScale !== 0) {
      const delta = r.se();
      nextScale = (lastScale + delta + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

/** Decode the coded picture dimensions from an SPS NAL (header byte + payload). */
function parseSpsDimensions(spsNal: Uint8Array): { width: number; height: number } {
  const r = new BitReader(toRbsp(spsNal.subarray(1)));
  const profileIdc = r.bits(8);
  r.bits(8); // constraint flags + reserved
  r.bits(8); // level_idc
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit(); // separate_colour_plane_flag
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      // seq_scaling_matrix_present_flag
      const count = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < count; i++) if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const picOrderCntType = r.ue();
  if (picOrderCntType === 0) {
    r.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (picOrderCntType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbsMinus1 = r.ue();
  const heightMapUnitsMinus1 = r.ue();
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit(); // mb_adaptive_frame_field_flag
  r.bit(); // direct_8x8_inference_flag
  let cropL = 0;
  let cropR = 0;
  let cropT = 0;
  let cropB = 0;
  if (r.bit()) {
    // frame_cropping_flag
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  const width = (widthMbsMinus1 + 1) * 16;
  const height = (2 - frameMbsOnly) * (heightMapUnitsMinus1 + 1) * 16;
  const subW = chromaFormatIdc === 0 ? 1 : 2;
  const subH = chromaFormatIdc === 0 ? 1 : 2;
  const cropUnitX = chromaFormatIdc === 0 ? 1 : subW;
  const cropUnitY = (chromaFormatIdc === 0 ? 1 : subH) * (2 - frameMbsOnly);
  return {
    width: Math.max(0, width - cropUnitX * (cropL + cropR)),
    height: Math.max(0, height - cropUnitY * (cropT + cropB)),
  };
}

/** WebCodecs/MSE `avc1.PPCCLL` codec string from an SPS NAL. */
export function codecStringFromSps(spsNal: Uint8Array): string {
  const hex = (b: number) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(spsNal[1])}${hex(spsNal[2])}${hex(spsNal[3])}`;
}

// ── muxer ─────────────────────────────────────────────────────────────────

const TIMESCALE = 90000;
const DEFAULT_FRAME_TICKS = 3000; // ~33ms fallback when no PTS delta is known
const IDENTITY_MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

const SAMPLE_FLAGS_KEY = 0x02000000; // sample_depends_on = 2 (I-frame), sync
const SAMPLE_FLAGS_DELTA = 0x01010000; // depends_on = 1, non-sync

export interface MuxResult {
  /** Present the first time (and whenever the codec config changes) — append before any segment. */
  init?: Uint8Array;
  /** A `moof`+`mdat` media fragment for this access unit, when it carried coded slices. */
  segment?: Uint8Array;
}

export class FragmentedMp4Muxer {
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private codecKey = '';
  private width = 0;
  private height = 0;
  private seq = 1;
  private baseMediaDecodeTime = 0;
  private prevPtsTicks: number | null = null;

  /** `avc1.PPCCLL` string for `MediaSource.isTypeSupported` / `addSourceBuffer`, once SPS is seen. */
  get codec(): string | null {
    return this.sps ? codecStringFromSps(this.sps) : null;
  }

  get ready(): boolean {
    return !!this.sps && !!this.pps;
  }

  /**
   * Feed one Annex-B access unit. Returns an `init` segment when the codec config
   * first becomes known or changes (e.g. a rotation resizes the stream), and a
   * media `segment` for the unit's coded slices.
   */
  append(au: Uint8Array, isKey: boolean, ptsUs: number | null): MuxResult {
    const mdatNals: Uint8Array[] = [];
    let sps: Uint8Array | null = null;
    let pps: Uint8Array | null = null;
    for (const nal of nalUnits(au)) {
      const type = nal[0] & 0x1f;
      if (type === 7) sps = nal.slice();
      else if (type === 8) pps = nal.slice();
      else if (type >= 1 && type <= 6) mdatNals.push(nal); // VCL slices + SEI
    }

    let init: Uint8Array | undefined;
    if (sps && pps) {
      const key = `${sps.join(',')}|${pps.join(',')}`;
      if (key !== this.codecKey) {
        this.sps = sps;
        this.pps = pps;
        this.codecKey = key;
        const dim = parseSpsDimensions(sps);
        this.width = dim.width;
        this.height = dim.height;
        init = this.buildInit();
      }
    }

    if (!this.ready || mdatNals.length === 0) return { init };

    const ptsTicks = ptsUs == null ? null : Math.round((ptsUs * TIMESCALE) / 1e6);
    let duration = DEFAULT_FRAME_TICKS;
    if (ptsTicks != null && this.prevPtsTicks != null) {
      const delta = ptsTicks - this.prevPtsTicks;
      duration = delta > 0 ? Math.min(delta, TIMESCALE * 5) : DEFAULT_FRAME_TICKS;
    }
    if (ptsTicks != null) this.prevPtsTicks = ptsTicks;

    const segment = this.buildSegment(mdatNals, isKey, duration);
    return { init, segment };
  }

  get dimensions(): { width: number; height: number } | null {
    return this.width && this.height ? { width: this.width, height: this.height } : null;
  }

  private buildInit(): Uint8Array {
    const sps = this.sps!;
    const pps = this.pps!;
    const avcc = box(
      'avcC',
      new Uint8Array([
        1, // configurationVersion
        sps[1], // AVCProfileIndication
        sps[2], // profile_compatibility
        sps[3], // AVCLevelIndication
        0xff, // 6b reserved + lengthSizeMinusOne (3)
        0xe1, // 3b reserved + numOfSequenceParameterSets (1)
      ]),
      u16(sps.byteLength),
      sps,
      new Uint8Array([1]), // numOfPictureParameterSets
      u16(pps.byteLength),
      pps,
    );

    const avc1 = box(
      'avc1',
      new Uint8Array(6), // reserved
      u16(1), // data_reference_index
      new Uint8Array(16), // pre_defined + reserved + pre_defined[3]
      u16(this.width),
      u16(this.height),
      u32(0x00480000), // horizresolution 72dpi
      u32(0x00480000), // vertresolution 72dpi
      u32(0),
      u16(1), // frame_count
      new Uint8Array(32), // compressorname
      u16(0x0018), // depth
      new Uint8Array([0xff, 0xff]), // pre_defined = -1
      avcc,
    );

    const stbl = box(
      'stbl',
      box('stsd', u32(0), u32(1), avc1),
      box('stts', u32(0), u32(0)),
      box('stsc', u32(0), u32(0)),
      box('stsz', u32(0), u32(0), u32(0)),
      box('stco', u32(0), u32(0)),
    );
    const dinf = box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1))));
    const minf = box('minf', box('vmhd', u32(1), u32(0), u32(0)), dinf, stbl);
    const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0));
    const hdlr = box(
      'hdlr',
      u32(0),
      u32(0),
      str4('vide'),
      u32(0),
      u32(0),
      u32(0),
      new Uint8Array([...str4('Vide'), ...str4('oHan'), ...str4('dler'), 0]),
    );
    const mdia = box('mdia', mdhd, hdlr, minf);

    const tkhd = box(
      'tkhd',
      new Uint8Array([0, 0, 0, 0x07]), // flags: enabled | in movie | in preview
      u32(0),
      u32(0),
      u32(1), // track_ID
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u16(0), // layer
      u16(0), // alternate_group
      u16(0), // volume
      u16(0),
      IDENTITY_MATRIX,
      u32(this.width << 16),
      u32(this.height << 16),
    );
    const trak = box('trak', tkhd, mdia);

    const mvhd = box(
      'mvhd',
      u32(0),
      u32(0),
      u32(0),
      u32(1000), // timescale
      u32(0), // duration
      u32(0x00010000), // rate
      u16(0x0100), // volume
      u16(0),
      u32(0),
      u32(0),
      IDENTITY_MATRIX,
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(0),
      u32(2), // next_track_ID
    );
    const trex = box('trex', u32(0), u32(1), u32(1), u32(0), u32(0), u32(0));
    const moov = box('moov', mvhd, trak, box('mvex', trex));

    const ftyp = box('ftyp', str4('isom'), u32(0), str4('isom'), str4('iso6'), str4('avc1'), str4('mp41'));
    return concat([ftyp, moov]);
  }

  private buildSegment(nals: Uint8Array[], isKey: boolean, duration: number): Uint8Array {
    let mdatSize = 0;
    for (const nal of nals) mdatSize += 4 + nal.byteLength;
    const mdatBody = new Uint8Array(mdatSize);
    let o = 0;
    for (const nal of nals) {
      mdatBody.set(u32(nal.byteLength), o);
      o += 4;
      mdatBody.set(nal, o);
      o += nal.byteLength;
    }

    const mfhd = box('mfhd', u32(0), u32(this.seq++));
    const tfhd = box('tfhd', new Uint8Array([0, 0x02, 0, 0]), u32(1)); // default-base-is-moof
    const tfdt = box('tfdt', new Uint8Array([1, 0, 0, 0]), u64(this.baseMediaDecodeTime));
    // trun: data-offset + sample-duration + sample-size + sample-flags present
    const trun = box(
      'trun',
      new Uint8Array([0, 0, 0x07, 0x01]),
      u32(1), // sample_count
      u32(0), // data_offset (patched below)
      u32(duration),
      u32(mdatSize),
      u32(isKey ? SAMPLE_FLAGS_KEY : SAMPLE_FLAGS_DELTA),
    );
    const moof = box('moof', mfhd, box('traf', tfhd, tfdt, trun));

    // data_offset points from the moof start to the first mdat payload byte. In a
    // single-sample trun it sits 16 bytes before the end of moof.
    new DataView(moof.buffer, moof.byteOffset, moof.byteLength).setInt32(
      moof.byteLength - 16,
      moof.byteLength + 8,
      false,
    );

    this.baseMediaDecodeTime += duration;
    return concat([moof, box('mdat', mdatBody)]);
  }
}
