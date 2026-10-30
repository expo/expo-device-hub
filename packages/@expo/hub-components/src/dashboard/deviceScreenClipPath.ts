import { type ScreenCornerRadii } from "./data";

const CIRCLE_SUPERELLIPSE_PARAMETER = 1;
const IOS_SUPERELLIPSE_PARAMETER = 1.1;
const CIRCLE_CONTROL = superellipseControl(CIRCLE_SUPERELLIPSE_PARAMETER);
const IOS_SUPERELLIPSE_CONTROL = superellipseControl(IOS_SUPERELLIPSE_PARAMETER);
const VERTICAL_EDGE_BLEED = "0.5px";

/** Matches a symmetric cubic's midpoint to the CSS superellipse(K) half-corner. */
function superellipseControl(parameter: number): number {
  const halfCorner = Math.pow(0.5, Math.pow(0.5, parameter));
  return (halfCorner - 0.5) / 0.375;
}

function cqw(value: number): string {
  return `${value.toFixed(3)}cqw`;
}

/** Corner radii in `cqw`, named by the corner as displayed. */
export type CornerRadiiCqw = ScreenCornerRadii;

/** Builds one responsive clip for the stream and every screen overlay. */
export function deviceScreenClipPath(radii: number | CornerRadiiCqw, squircle: boolean): string {
  const { topLeft, topRight, bottomRight, bottomLeft } =
    typeof radii === "number"
      ? { topLeft: radii, topRight: radii, bottomRight: radii, bottomLeft: radii }
      : radii;
  const controlScale = squircle ? IOS_SUPERELLIPSE_CONTROL : CIRCLE_CONTROL;
  const control = (radius: number) => cqw(radius * controlScale);
  const top = `-${VERTICAL_EDGE_BLEED}`;
  const bottom = `calc(100% + ${VERTICAL_EDGE_BLEED})`;
  // The vertical edges extend past the top and bottom by the bleed, so the
  // curves start and end that much inside their radius.
  const upper = (radius: number) => `calc(${cqw(radius)} - ${VERTICAL_EDGE_BLEED})`;
  const lower = (radius: number) => `calc(100% - ${cqw(radius)} + ${VERTICAL_EDGE_BLEED})`;
  const fromRight = (radius: number) => `calc(100% - ${cqw(radius)})`;

  return [
    `shape(from ${cqw(topLeft)} ${top}`,
    `hline to ${fromRight(topRight)}`,
    `curve to 100% ${upper(topRight)} with ${control(topRight)} 0 from start / 0 -${control(topRight)} from end`,
    `vline to ${lower(bottomRight)}`,
    `curve to ${fromRight(bottomRight)} ${bottom} with 0 ${control(bottomRight)} from start / ${control(bottomRight)} 0 from end`,
    `hline to ${cqw(bottomLeft)}`,
    `curve to 0 ${lower(bottomLeft)} with -${control(bottomLeft)} 0 from start / 0 ${control(bottomLeft)} from end`,
    `vline to ${upper(topLeft)}`,
    `curve to ${cqw(topLeft)} ${top} with 0 -${control(topLeft)} from start / -${control(topLeft)} 0 from end`,
    "close)",
  ].join(", ");
}
