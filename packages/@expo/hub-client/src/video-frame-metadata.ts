/** Count frames presented between browser callbacks, including skipped callbacks. */
export function presentedVideoFrameDelta(
  previousPresentedFrames: number | null,
  presentedFrames: number,
): number {
  if (!Number.isSafeInteger(presentedFrames) || presentedFrames < 0) return 1;
  if (
    previousPresentedFrames === null ||
    !Number.isSafeInteger(previousPresentedFrames) ||
    presentedFrames <= previousPresentedFrames
  ) {
    return 1;
  }
  return presentedFrames - previousPresentedFrames;
}
