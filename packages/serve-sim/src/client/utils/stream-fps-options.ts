const MAX_UI_STREAM_FPS = 60;
const FPS_PRESETS = [60, 30, 20, 15, 10, 5] as const;

type StreamFpsOption = { value: string; label: string };

const FPS_OPTIONS: StreamFpsOption[] = FPS_PRESETS.map((fps) => {
  const value = String(fps);
  return { value, label: value };
});

/** Keep experimental rates available to CLI/API callers, but not selectable in the UI. */
export function streamFpsOptions(currentFps: number): StreamFpsOption[] {
  const current = String(currentFps);
  if (
    currentFps <= MAX_UI_STREAM_FPS
    && !FPS_OPTIONS.some((option) => option.value === current)
  ) {
    return [{ value: current, label: current }, ...FPS_OPTIONS];
  }
  return FPS_OPTIONS;
}
