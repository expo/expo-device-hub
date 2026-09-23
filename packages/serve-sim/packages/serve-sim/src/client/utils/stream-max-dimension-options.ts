import type { StreamControlSettings } from "../../stream-settings";

type MaxDimensionOption = { value: string; label: string };

/// Largest long edge offered for WebRTC H.264. Mirrors the encoder's own default cap.
const H264_MAX_LONG_EDGE = 1280;

const FULL: MaxDimensionOption = { value: "0", label: "Full" };
const PRESETS: MaxDimensionOption[] = [1920, 1600, 1280, 960, 720].map((size) => ({
  value: String(size),
  label: String(size),
}));

/// The picker never offers a size the session would refuse to honor:
///
/// - A session started with `--max-dimension` caps the list at that size.
/// - WebRTC H.264 additionally caps at 1280 and never offers Full (native), because
///   above that the encoder stalls and does not recover.
///
/// `configured` is the session's boot setting, not the current one, so choosing a smaller
/// size stays reversible. The current value is always kept selectable, so the picker
/// reflects the real state even when that state is above the ceiling.
export function maxDimensionOptions(
  settings: Pick<StreamControlSettings, "transport" | "webRtcCodec" | "maxDimension">,
  configured: number,
): MaxDimensionOption[] {
  const h264 = settings.transport === "webrtc" && settings.webRtcCodec === "h264";
  const ceiling = configured > 0 ? configured : h264 ? H264_MAX_LONG_EDGE : 0;
  const options = ceiling > 0
    ? PRESETS.filter((option) => Number(option.value) <= ceiling)
    : [FULL, ...PRESETS];
  return withCurrent(settings.maxDimension, options);
}

function withCurrent(value: number, options: MaxDimensionOption[]): MaxDimensionOption[] {
  const current = String(value);
  if (options.some((option) => option.value === current)) return options;
  return [...options, value === 0 ? FULL : { value: current, label: current }];
}
