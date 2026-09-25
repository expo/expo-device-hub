import type { StreamControlSettings } from "../../stream-settings";

type MaxDimensionOption = { value: string; label: string };

const FULL: MaxDimensionOption = { value: "0", label: "Full" };
const PRESETS: MaxDimensionOption[] = [1920, 1600, 1280, 960, 720].map((size) => ({
  value: String(size),
  label: String(size),
}));

/// A session started with `--max-dimension` caps the list at that size.
///
/// `configured` is the session's boot setting, not the current one, so choosing a smaller
/// size stays reversible. The current value is always kept selectable, so the picker
/// reflects the real state even when that state is above the ceiling.
export function maxDimensionOptions(
  settings: Pick<StreamControlSettings, "maxDimension">,
  configured: number,
): MaxDimensionOption[] {
  const options = configured > 0
    ? PRESETS.filter((option) => Number(option.value) <= configured)
    : [FULL, ...PRESETS];
  return withCurrent(settings.maxDimension, options);
}

function withCurrent(value: number, options: MaxDimensionOption[]): MaxDimensionOption[] {
  const current = String(value);
  if (options.some((option) => option.value === current)) return options;
  return [...options, value === 0 ? FULL : { value: current, label: current }];
}
