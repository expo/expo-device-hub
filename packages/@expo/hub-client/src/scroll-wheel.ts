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

type ScrollDelta = { dx: number; dy: number; x: number; y: number };

/** Start immediately, then accumulate wheel distance at the display cadence. */
export function createFrameScrollSender(send: (sample: ScrollDelta) => void) {
  let frame: number | null = null;
  let pending: ScrollDelta | null = null;
  const flush = () => {
    const sample = pending;
    pending = null;
    if (!sample) {
      frame = null;
      return;
    }
    frame = requestAnimationFrame(flush);
    if (sample.dx !== 0 || sample.dy !== 0) send(sample);
  };
  return {
    send(sample: ScrollDelta) {
      if (frame === null) {
        frame = requestAnimationFrame(flush);
        send(sample);
      } else {
        pending = {
          ...sample,
          dx: (pending?.dx ?? 0) + sample.dx,
          dy: (pending?.dy ?? 0) + sample.dy,
        };
      }
    },
    cancel() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      pending = null;
    },
  };
}
