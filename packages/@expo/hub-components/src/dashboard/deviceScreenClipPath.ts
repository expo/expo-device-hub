import { type CSSProperties } from 'react';

// Cubic Bézier control points for a quarter circle and for the
// x^(2^1.3) + y^(2^1.3) = 1 superellipse used by the iOS frame.
const CIRCLE_CONTROL = 0.552285;
const IOS_SUPERELLIPSE_CONTROL = 0.683437;
const VERTICAL_EDGE_BLEED = '0.5px';

function cqw(value: number): string {
  return `${value.toFixed(3)}cqw`;
}

/** Builds one responsive clip for the stream and every screen overlay. */
export function deviceScreenClipPath(
  radiusCqw: number,
  squircle: boolean
): CSSProperties['clipPath'] {
  const radius = cqw(radiusCqw);
  const control = cqw(radiusCqw * (squircle ? IOS_SUPERELLIPSE_CONTROL : CIRCLE_CONTROL));
  const top = `-${VERTICAL_EDGE_BLEED}`;
  const topRadius = `calc(${radius} - ${VERTICAL_EDGE_BLEED})`;
  const bottomRadius = `calc(100% - ${radius} + ${VERTICAL_EDGE_BLEED})`;
  const bottom = `calc(100% + ${VERTICAL_EDGE_BLEED})`;

  return [
    `shape(from ${radius} ${top}`,
    `hline to calc(100% - ${radius})`,
    `curve to 100% ${topRadius} with ${control} 0 from start / 0 -${control} from end`,
    `vline to ${bottomRadius}`,
    `curve to calc(100% - ${radius}) ${bottom} with 0 ${control} from start / ${control} 0 from end`,
    `hline to ${radius}`,
    `curve to 0 ${bottomRadius} with -${control} 0 from start / 0 ${control} from end`,
    `vline to ${topRadius}`,
    `curve to ${radius} ${top} with 0 -${control} from start / -${control} 0 from end`,
    'close)',
  ].join(', ');
}
