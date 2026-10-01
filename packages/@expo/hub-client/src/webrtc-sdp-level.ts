/// Level 5.2. Allows 36864 macroblocks per frame, past any simulator surface.
export const H264_SEND_LEVEL_IDC = 0x34;

/// Level 1b is level_idc 11 plus constraint_set3_flag, so the flag has to go when raising.
/// For High profiles the same bit means Intra, which must be left alone.
const LEVEL_IDC_1B = 0x0b;
const CONSTRAINT_SET3_FLAG = 0x10;
const LEVEL_1B_PROFILE_IDCS = new Set([0x42, 0x4d, 0x58]);

/// Exactly 6 hex digits; a longer run is malformed and must not be half-rewritten.
const PROFILE_LEVEL_ID = /(profile-level-id=)([0-9a-fA-F]{6})(?![0-9a-fA-F])/g;
const ASYMMETRIC_FMTP_LINE = /^a=fmtp:[^\r\n]*\blevel-asymmetry-allowed=1\b[^\r\n]*$/gm;

/// Raise the level in every H.264 `profile-level-id` that allows level asymmetry. Browsers
/// advertise 3.1 whatever they can decode, and libwebrtc encodes nothing past the level in
/// this offer. Without asymmetry both directions share one level, so the browser would hold
/// the answer to the 3.1 its own offer still says.
///
/// Rests on measurement, not the spec, and the ladder is no safety net: a decoder that limps
/// rather than stops never trips it. See docs/webrtc-architecture.md and `H264LevelPolicy.swift`.
export function raiseH264OfferLevel(sdp: string, levelIdc: number = H264_SEND_LEVEL_IDC): string {
  if (!Number.isInteger(levelIdc) || levelIdc <= 0 || levelIdc > 0xff) return sdp;
  const raised = levelIdc.toString(16).padStart(2, "0");
  const raiseLevel = (match: string, prefix: string, value: string) => {
    const profileIdc = Number.parseInt(value.slice(0, 2), 16);
    const profileIop = Number.parseInt(value.slice(2, 4), 16);
    const current = Number.parseInt(value.slice(4, 6), 16);
    if (current >= levelIdc) return match;
    const clearsLevel1BFlag = current === LEVEL_IDC_1B && LEVEL_1B_PROFILE_IDCS.has(profileIdc);
    const iop = clearsLevel1BFlag ? profileIop & ~CONSTRAINT_SET3_FLAG : profileIop;
    return `${prefix}${value.slice(0, 2)}${iop.toString(16).padStart(2, "0")}${raised}`;
  };
  return sdp.replace(ASYMMETRIC_FMTP_LINE, (line) => line.replace(PROFILE_LEVEL_ID, raiseLevel));
}
