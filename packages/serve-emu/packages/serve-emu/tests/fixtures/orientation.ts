/**
 * A display orientation read that fails without running adb, so `/api` and `/health` report
 * `null` as they do before the first read. For tests that do not check the orientation.
 */
export async function readNoOrientation(): Promise<never> {
  throw new Error("display orientation is not read in this test");
}

/**
 * An orientation event stream that stays open and reports nothing until the recording ends,
 * without running adb logcat. For tests that do not check when the orientation changes.
 */
export function watchNoOrientationEvents(
  _serial: string,
  _onEvent: () => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
