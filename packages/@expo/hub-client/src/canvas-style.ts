import { type CSSProperties } from 'react';

// Scale the H.264 canvas so its antialiased GPU layer edge falls outside the
// screen's overflow clip. This mirrors serve-sim's seam workaround.
const CANVAS_SEAM_OVERSHOOT = 1.004;

export function withCanvasSeamOvershoot(style: CSSProperties): CSSProperties {
  return {
    ...style,
    transform: `${style.transform ?? ''} scale(${CANVAS_SEAM_OVERSHOOT})`,
  };
}
