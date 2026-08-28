const CIRCLE_SUPERELLIPSE_PARAMETER = 1;
const IOS_SUPERELLIPSE_PARAMETER = 1.1;
const CIRCLE_CONTROL = superellipseControl(CIRCLE_SUPERELLIPSE_PARAMETER);
const IOS_SUPERELLIPSE_CONTROL = superellipseControl(IOS_SUPERELLIPSE_PARAMETER);
const VERTICAL_EDGE_BLEED = '0.5px';

/** Matches a symmetric cubic's midpoint to the CSS superellipse(K) half-corner. */
function superellipseControl(parameter: number): number {
  const halfCorner = Math.pow(0.5, Math.pow(0.5, parameter));
  return (halfCorner - 0.5) / 0.375;
}

function cqw(value: number): string {
  return `${value.toFixed(3)}cqw`;
}

function percentage(value: number): string {
  return `${value.toFixed(3)}%`;
}

/** Builds one responsive clip for the stream and every screen overlay. */
export function deviceScreenClipPath(radiusCqw: number, squircle: boolean): string {
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

/** Build the calibrated transparent opening for a frame-artwork viewport. */
export function deviceFrameScreenClipPath(
  radiusXPercent: number,
  radiusYPercent: number,
  superellipseParameter: number,
): string {
  const radiusX = percentage(radiusXPercent);
  const radiusY = percentage(radiusYPercent);
  const controlFactor = superellipseControl(superellipseParameter);
  const controlX = percentage(radiusXPercent * controlFactor);
  const controlY = percentage(radiusYPercent * controlFactor);
  const top = `-${VERTICAL_EDGE_BLEED}`;
  const topRadius = `calc(${radiusY} - ${VERTICAL_EDGE_BLEED})`;
  const bottomRadius = `calc(100% - ${radiusY} + ${VERTICAL_EDGE_BLEED})`;
  const bottom = `calc(100% + ${VERTICAL_EDGE_BLEED})`;

  return [
    `shape(from ${radiusX} ${top}`,
    `hline to calc(100% - ${radiusX})`,
    `curve to 100% ${topRadius} with ${controlX} 0 from start / 0 -${controlY} from end`,
    `vline to ${bottomRadius}`,
    `curve to calc(100% - ${radiusX}) ${bottom} with 0 ${controlY} from start / ${controlX} 0 from end`,
    `hline to ${radiusX}`,
    `curve to 0 ${bottomRadius} with -${controlX} 0 from start / 0 ${controlY} from end`,
    `vline to ${topRadius}`,
    `curve to ${radiusX} ${top} with 0 -${controlY} from start / -${controlX} 0 from end`,
    'close)',
  ].join(', ');
}
