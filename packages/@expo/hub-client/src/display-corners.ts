/**
 * Glass corners of a simulator display, from the DeviceKit chrome descriptor
 * serve-sim advertises in its `/api` config. Mirrors serve-sim's
 * `deviceKitChromeForScreen` and `deviceKitScreenRadius`
 * (`src/client/components/device-chrome-frame.tsx`, @expo/serve-sim 0.5.0),
 * which round the flat stream with the active display's own corners.
 */

import { type DeviceOrientation, type DisplayCornerRadii } from './types';

/** Per-corner radii in the descriptor's point coordinates, clockwise from top left. */
export interface DeviceDisplayCornerRadii {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/** The subset of serve-sim's `DeviceKitChromeDescriptor` the Hub reads. */
export interface DeviceDisplayChrome {
  /** DeviceKit chrome profile, e.g. `phone15` for the Duo's cover and `phone14` for its inner display. */
  identifier?: string;
  /** The display's rectangle in the chrome's point coordinates. */
  screen?: { width: number; height: number };
  /** One radius for every corner, when the profile has no per-corner values. */
  screenRadius?: number;
  screenCornerRadii?: DeviceDisplayCornerRadii;
  screenId?: number;
  /** Other integrated displays of the same device, keyed by their screen id. */
  displayVariants?: Record<string, DeviceDisplayChrome>;
}

/** The descriptor of the active display: a variant when one matches, else the primary. */
export function displayChromeForScreen(
  chrome: DeviceDisplayChrome,
  screenId?: number,
): DeviceDisplayChrome {
  return (screenId === undefined ? undefined : chrome.displayVariants?.[String(screenId)]) ?? chrome;
}

/**
 * The active display's corners as the viewer sees them, as fractions of the
 * displayed width. The physical corners turn with the device, so a landscape
 * device shows its portrait top-left corner at the bottom left (landscape left)
 * or top right (landscape right), exactly as serve-sim orders them.
 */
export function displayCornerRadii(
  chrome: DeviceDisplayChrome,
  orientation?: DeviceOrientation,
): DisplayCornerRadii | null {
  const screen = chrome.screen;
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return null;
  const landscape = orientation === 'landscape_left' || orientation === 'landscape_right';
  const width = landscape ? screen.height : screen.width;
  const corners = chrome.screenCornerRadii;
  const physical: [number, number, number, number] = corners
    ? [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft]
    : typeof chrome.screenRadius === 'number'
      ? [chrome.screenRadius, chrome.screenRadius, chrome.screenRadius, chrome.screenRadius]
      : [NaN, NaN, NaN, NaN];
  if (!physical.every((radius) => Number.isFinite(radius) && radius >= 0)) return null;
  const [topLeft, topRight, bottomRight, bottomLeft] = physical;
  const displayed =
    orientation === 'landscape_left'
      ? [bottomLeft, topLeft, topRight, bottomRight]
      : orientation === 'landscape_right'
        ? [topRight, bottomRight, bottomLeft, topLeft]
        : orientation === 'portrait_upside_down'
          ? [bottomRight, bottomLeft, topLeft, topRight]
          : [topLeft, topRight, bottomRight, bottomLeft];
  return {
    topLeft: displayed[0]! / width,
    topRight: displayed[1]! / width,
    bottomRight: displayed[2]! / width,
    bottomLeft: displayed[3]! / width,
  };
}
