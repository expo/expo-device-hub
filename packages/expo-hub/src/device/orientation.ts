/**
 * Orientation + home-indicator geometry, ported from serve-sim's
 * `serve-sim-client/src/simulator/orientation.ts`.
 *
 * Two concerns:
 *   - Input: map a touch in *display* space (what the user sees/clicks) to the
 *     device's *raw* frame space the helper expects ({@link rawPointForDisplayPoint},
 *     {@link rawEdgeForDisplayEdge}).
 *   - Display: when the helper streams un-rotated (portrait) frames for a rotated
 *     device, the client rotates the video for display ({@link streamGeometry}).
 */

import { type DeviceOrientation, type ScreenSize } from './types';

export const HID_EDGE_LEFT = 1;
export const HID_EDGE_TOP = 2;
export const HID_EDGE_BOTTOM = 3;
export const HID_EDGE_RIGHT = 4;

/**
 * Bottom fraction of the display treated as the home-indicator hot zone. A drag
 * that *starts* here is tagged with `HID_EDGE_BOTTOM` so iOS routes it to the
 * interactive swipe-to-home / app-switcher recognizer. Kept narrow (bottom 7%)
 * so it doesn't swallow bottom-bar swipes.
 */
export const HOME_INDICATOR_BAND_NORM = 0.93;

/** `HID_EDGE_BOTTOM` when a display-space `y` is in the hot zone, else undefined. */
export function homeIndicatorEdge(y: number): number | undefined {
  return y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : undefined;
}

export function isLandscapeOrientation(orientation?: DeviceOrientation | null): boolean {
  return orientation === 'landscape_left' || orientation === 'landscape_right';
}

export function rotationDegreesForOrientation(orientation?: DeviceOrientation | null): number {
  switch (orientation) {
    case 'landscape_left':
      return 90;
    case 'landscape_right':
      return -90;
    case 'portrait_upside_down':
      return 180;
    default:
      return 0;
  }
}

/** The screen size as it should be *displayed* (width/height swapped for landscape). */
export function displayScreen(config?: ScreenSize | null): ScreenSize | null {
  if (!config || config.width <= 0 || config.height <= 0) return null;
  const landscape = isLandscapeOrientation(config.orientation) || config.width > config.height;
  const width = landscape ? Math.max(config.width, config.height) : Math.min(config.width, config.height);
  const height = landscape ? Math.min(config.width, config.height) : Math.max(config.width, config.height);
  if (width === config.width && height === config.height) return config;
  return { ...config, width, height };
}

export interface StreamGeometry {
  /** Orientation-corrected dimensions for sizing the frame. */
  display: ScreenSize | null;
  /** CSS rotation to apply to the video element (0 when the frame is already upright). */
  rotationDegrees: number;
  needsRotation: boolean;
  /** Orientation to feed {@link rawPointForDisplayPoint} for input; set only when rotating. */
  inputOrientation?: DeviceOrientation;
}

/**
 * Whether/how to rotate the video for display and remap input. The helper sends
 * already-rotated (landscape) frames sometimes and raw (portrait) frames other
 * times; only the latter needs client-side rotation + input remapping.
 */
export function streamGeometry(config?: ScreenSize | null): StreamGeometry {
  const display = displayScreen(config);
  const orientationRotation = rotationDegreesForOrientation(config?.orientation);
  const rotatesSideways = Math.abs(orientationRotation) === 90;
  const rawIsLandscape = !!config && config.width > config.height;
  const needsRotation = orientationRotation === 180 || (rotatesSideways && !rawIsLandscape);
  return {
    display,
    rotationDegrees: needsRotation ? orientationRotation : 0,
    needsRotation,
    inputOrientation: needsRotation ? config?.orientation : undefined,
  };
}

/** Map a normalized display-space point to the device's raw frame space. */
export function rawPointForDisplayPoint(
  orientation: DeviceOrientation | null | undefined,
  x: number,
  y: number,
): { x: number; y: number } {
  switch (orientation) {
    case 'landscape_left':
      return { x: y, y: 1 - x };
    case 'landscape_right':
      return { x: 1 - y, y: x };
    case 'portrait_upside_down':
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

/** Map a display-space HID edge to the raw-frame edge for the current orientation. */
export function rawEdgeForDisplayEdge(
  orientation: DeviceOrientation | null | undefined,
  edge: number,
): number {
  switch (orientation) {
    case 'landscape_left':
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_RIGHT:
          return HID_EDGE_TOP;
        case HID_EDGE_TOP:
          return HID_EDGE_LEFT;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_RIGHT;
        default:
          return edge;
      }
    case 'landscape_right':
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_TOP;
        case HID_EDGE_RIGHT:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_TOP:
          return HID_EDGE_RIGHT;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_LEFT;
        default:
          return edge;
      }
    case 'portrait_upside_down':
      switch (edge) {
        case HID_EDGE_LEFT:
          return HID_EDGE_RIGHT;
        case HID_EDGE_RIGHT:
          return HID_EDGE_LEFT;
        case HID_EDGE_TOP:
          return HID_EDGE_BOTTOM;
        case HID_EDGE_BOTTOM:
          return HID_EDGE_TOP;
        default:
          return edge;
      }
    default:
      return edge;
  }
}
