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

/** Corner radii in container-width units, clockwise from top left. */
export type ScreenCornerRadiiCqw = {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
};

/** Builds one responsive clip for the stream and every screen overlay. */
export function deviceScreenClipPath(radiusCqw: number, squircle: boolean): string {
  return deviceScreenCornersClipPath(
    { topLeft: radiusCqw, topRight: radiusCqw, bottomRight: radiusCqw, bottomLeft: radiusCqw },
    squircle,
  );
}

/**
 * The same clip with one radius per corner, for displays whose glass is not
 * symmetric: the iPhone Duo's cover is nearly square at the hinge and round at
 * its outer edge. DeviceKit corners are circular, so callers pass `squircle`
 * false for them.
 */
export function deviceScreenCornersClipPath(radii: ScreenCornerRadiiCqw, squircle: boolean): string {
  const controlFactor = squircle ? IOS_SUPERELLIPSE_CONTROL : CIRCLE_CONTROL;
  const tl = cqw(radii.topLeft);
  const tr = cqw(radii.topRight);
  const br = cqw(radii.bottomRight);
  const bl = cqw(radii.bottomLeft);
  const tlControl = cqw(radii.topLeft * controlFactor);
  const trControl = cqw(radii.topRight * controlFactor);
  const brControl = cqw(radii.bottomRight * controlFactor);
  const blControl = cqw(radii.bottomLeft * controlFactor);
  const top = `-${VERTICAL_EDGE_BLEED}`;
  const bottom = `calc(100% + ${VERTICAL_EDGE_BLEED})`;

  return [
    `shape(from ${tl} ${top}`,
    `hline to calc(100% - ${tr})`,
    `curve to 100% calc(${tr} - ${VERTICAL_EDGE_BLEED}) with ${trControl} 0 from start / 0 -${trControl} from end`,
    `vline to calc(100% - ${br} + ${VERTICAL_EDGE_BLEED})`,
    `curve to calc(100% - ${br}) ${bottom} with 0 ${brControl} from start / ${brControl} 0 from end`,
    `hline to ${bl}`,
    `curve to 0 calc(100% - ${bl} + ${VERTICAL_EDGE_BLEED}) with -${blControl} 0 from start / 0 ${blControl} from end`,
    `vline to calc(${tl} - ${VERTICAL_EDGE_BLEED})`,
    `curve to ${tl} ${top} with 0 -${tlControl} from start / -${tlControl} 0 from end`,
    'close)',
  ].join(', ');
}
