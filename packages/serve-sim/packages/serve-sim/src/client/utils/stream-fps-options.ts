const FPS_PRESETS = [120, 60, 30, 20, 15, 10, 5] as const;

type StreamFpsOption = { value: string; label: string };

/**
 * The menu's frame rates up to `maxFps`. Only the video menu raises it to 120; MJPEG at 120 would
 * spend too much time on JPEG encodes. Higher rates stay available to CLI/API callers.
 */
export function streamFpsOptions(currentFps: number, maxFps = 60): StreamFpsOption[] {
  const options = FPS_PRESETS.filter((fps) => fps <= maxFps).map((fps) => {
    const value = String(fps);
    return { value, label: value };
  });
  const current = String(currentFps);
  if (currentFps <= maxFps && !options.some((option) => option.value === current)) {
    return [{ value: current, label: current }, ...options];
  }
  return options;
}
