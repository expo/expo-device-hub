/** Pixels per `WheelEvent.deltaMode === DOM_DELTA_LINE` step. */
export const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Convert a raw `WheelEvent.deltaX/Y` (respecting `deltaMode`) into CSS pixels.
 * Line- and page-mode deltas are normalized so downstream code only deals in
 * pixels. Ported from serve-sim's `simulator/scroll-wheel.ts`.
 */
export function wheelDeltaToPixels(delta: number, deltaMode: number, axisLengthPx: number): number {
  if (!Number.isFinite(delta)) return 0;
  const safeAxis = Number.isFinite(axisLengthPx) && axisLengthPx > 0 ? axisLengthPx : 1;
  if (deltaMode === 1) return delta * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * safeAxis;
  return delta;
}
