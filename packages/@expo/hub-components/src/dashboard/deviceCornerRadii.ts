import { type DeviceOrientation } from "@expo/hub-client";

import { type ScreenCornerRadii } from "./data";
import { deviceFrameRotation } from "./deviceFrame";

/**
 * Turn portrait corner radii into the radii of the displayed screen, in `cqw`
 * of the rendered width.
 *
 * Each radius is a fraction of the portrait width, which is the screen's short
 * side. The rendered width is the long side in landscape, so dividing by
 * `max(ratio, 1)` keeps the corners the same physical size in both
 * orientations. A rotated device moves each corner to a new place on screen.
 */
export function orientedCornerRadiiCqw(
  radii: ScreenCornerRadii,
  orientation: DeviceOrientation | null | undefined,
  displayRatio: number,
): ScreenCornerRadii {
  const { topLeft, topRight, bottomRight, bottomLeft } = radii;
  const [tl, tr, br, bl] = ((): [number, number, number, number] => {
    switch (deviceFrameRotation(orientation, displayRatio)) {
      case 90:
        return [bottomLeft, topLeft, topRight, bottomRight];
      case -90:
        return [topRight, bottomRight, bottomLeft, topLeft];
      case 180:
        return [bottomRight, bottomLeft, topLeft, topRight];
      default:
        return [topLeft, topRight, bottomRight, bottomLeft];
    }
  })();
  const toCqw = (fraction: number) => (fraction / Math.max(displayRatio, 1)) * 100;

  return {
    topLeft: toCqw(tl),
    topRight: toCqw(tr),
    bottomRight: toCqw(br),
    bottomLeft: toCqw(bl),
  };
}

/** CSS `border-radius` for a set of corner radii in `cqw`. */
export function cornerRadiiBorderRadius(radii: ScreenCornerRadii): string {
  return [radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft]
    .map((radius) => `${radius.toFixed(3)}cqw`)
    .join(" ");
}
