import type { EncoderIdentity, SenderStreamStats } from "../../webrtc-sender-stats";

/**
 * The encoder's own view. None of this is visible to a receive-only browser.
 *
 * `paravirtualized:` marks a guest reaching the host's hardware encoder. A session with no
 * encoder id is not on H.264, so it falls back to naming its codec.
 */
export function encoderLabel(encoder: Omit<EncoderIdentity, "probe">): string {
  const kind = encoder.hardware === true ? "hardware" : encoder.hardware === false ? "CPU" : "?";
  const id = encoder.id ?? "";
  if (!id) return encoder.codec ? `${encoder.codec.toLowerCase()} (${kind})` : kind;
  const tail = id.split(".").pop() ?? id;
  return `${id.startsWith("paravirtualized:") ? `paravirt ${tail}` : tail} (${kind})`;
}

/// `bandwidth` is the bitrate budget, not packet loss, so neither wording blames the network.
/// `short` tags the size line, `long` stands alone in the fault list.
const QUALITY_LIMITATION: Record<string, { short: string; long: string }> = {
  cpu: { short: "encoder", long: "Encoder cannot keep up (CPU)" },
  bandwidth: { short: "bitrate", long: "Quality reduced to fit the bitrate" },
};

export function qualityLimitation(
  reason: string | null | undefined,
): { short: string; long: string } | null {
  if (!reason || reason === "none") return null;
  return QUALITY_LIMITATION[reason] ?? { short: reason, long: "Encoder holding back (reason unknown)" };
}

/// Encoders round to even dimensions, so a ceiling can be missed by one step.
const EVEN_PX = 2;

type DownscaleStats = Pick<
  SenderStreamStats,
  "width" | "height" | "qualityLimitationReason" | "sourceLongEdge" | "levelMaxLongEdge"
>;

/** Why the picture is smaller than the size that was picked. */
/// The codec level is checked before the runtime causes: libwebrtc reports no limitation for
/// a ceiling we applied ourselves, so whatever it does report would take the blame.
export function describeDownscale(
  selectedMaxDimension: number,
  sender: DownscaleStats,
): string | null {
  const longEdge = Math.max(sender.width ?? 0, sender.height ?? 0);
  const source = sender.sourceLongEdge ?? 0;
  const picked = selectedMaxDimension > 0 ? selectedMaxDimension : source;
  const target = source > 0 ? Math.min(picked, source) : picked;
  if (target <= 0 || longEdge <= 0 || longEdge >= target) return null;
  const capped = sender.levelMaxLongEdge ?? 0;
  const reason = sender.qualityLimitationReason;
  // Only at the level's ceiling; below it something else owns the answer.
  const atCodecCeiling = capped > 0 && capped < target && longEdge >= capped - EVEN_PX;
  const cause = atCodecCeiling
    ? "codec level"
    : qualityLimitation(reason)?.short ?? null;
  return `${longEdge} of ${target}${cause ? ` (${cause})` : ""}`;
}
