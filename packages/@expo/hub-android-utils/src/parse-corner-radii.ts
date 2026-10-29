import { type ScreenCornerRadii } from "./types";

const DISPLAY_SIZE = /DisplayDeviceInfo\{[^\n]*?,\s*(\d+) x (\d+),/;
const ROUNDED_CORNERS = /roundedCorners RoundedCorners\{\[(.*?)\]\}/;
/** Android 12 (API 31) added corner reporting to `dumpsys display`. */
const FIRST_SDK_WITH_ROUNDED_CORNERS = 31;
const ROUNDED_CORNER = /RoundedCorner\{position=(\w+), radius=(\d+)/g;

/**
 * Parse the built-in screen's corner radii from `dumpsys display` output.
 *
 * Android reports each radius in physical pixels, so every radius is divided by
 * the short side of the display to give a fraction of the portrait width.
 * Android 12 and newer print no corners when every radius is zero, so with
 * `sdkLevel` at 31 or higher a display that lists none has square corners.
 * Returns `null` when the output has no display size, or no complete set of four
 * rounded corners on an Android version that does not say (Android 11 and older
 * never report them).
 */
export function parseCornerRadii(dumpsys: string, sdkLevel?: number): ScreenCornerRadii | null {
  const size = DISPLAY_SIZE.exec(dumpsys);
  if (!size) return null;

  const shortSide = Math.min(Number(size[1]), Number(size[2]));
  if (!Number.isFinite(shortSide) || shortSide <= 0) return null;

  const corners = ROUNDED_CORNERS.exec(dumpsys)?.[1];
  if (!corners) {
    const reportsCorners = sdkLevel !== undefined && sdkLevel >= FIRST_SDK_WITH_ROUNDED_CORNERS;
    return reportsCorners && !/roundedCorners/i.test(dumpsys)
      ? { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 }
      : null;
  }

  const radii = new Map<string, number>();
  for (const [, position, radius] of corners.matchAll(ROUNDED_CORNER)) {
    if (position !== undefined && radius !== undefined) {
      radii.set(position, Number(radius) / shortSide);
    }
  }
  const topLeft = radii.get("TopLeft");
  const topRight = radii.get("TopRight");
  const bottomRight = radii.get("BottomRight");
  const bottomLeft = radii.get("BottomLeft");
  if (
    topLeft === undefined ||
    topRight === undefined ||
    bottomRight === undefined ||
    bottomLeft === undefined
  ) {
    return null;
  }
  return { topLeft, topRight, bottomRight, bottomLeft };
}
