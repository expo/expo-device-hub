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

import { type HingePhysicalOrientation } from "./hinge-control";
import { type DeviceOrientation, type ScreenSize, type TouchSample } from "./types";

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

export function homeIndicatorEdge(
  { x = 0.5, y, edgeGestures = true }: Pick<TouchSample, "y" | "edgeGestures"> & { x?: number },
  config?: ScreenSize | null,
): number | undefined {
  if (!edgeGestures) return undefined;
  // The home indicator follows the app interface, which can stay portrait while
  // the physical device turns. Older helpers only report the display bottom.
  const turn =
    config?.deviceOrientation !== undefined
      ? (((rotationDegreesForOrientation(framingOrientation(config)) -
          rotationDegreesForOrientation(interfaceOrientation(config))) %
          360) +
          360) %
        360
      : 0;
  switch (turn) {
    case 90:
      return x <= 1 - HOME_INDICATOR_BAND_NORM ? HID_EDGE_LEFT : undefined;
    case 180:
      return y <= 1 - HOME_INDICATOR_BAND_NORM ? HID_EDGE_TOP : undefined;
    case 270:
      return x >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_RIGHT : undefined;
    default:
      return y >= HOME_INDICATOR_BAND_NORM ? HID_EDGE_BOTTOM : undefined;
  }
}

/**
 * How long a backend's answer outranks a report of another pose: the display can turn after
 * the answer, and an app can keep its own orientation.
 */
export const READBACK_GRACE_MS = 1500;

export function isDeviceOrientation(value: unknown): value is DeviceOrientation {
  return (DEVICE_ORIENTATIONS as readonly unknown[]).includes(value);
}

/**
 * The four poses, in the order Rotate steps through them on Android and on an
 * ordinary iPhone without native pose controls (a known observed pose and the
 * matching capability). An iPhone Duo with native pose controls also uses this
 * order: its names are then physical poses, and this order turns them clockwise.
 */
export const DEVICE_ORIENTATIONS = [
  "portrait",
  "landscape_left",
  "portrait_upside_down",
  "landscape_right",
] as const satisfies readonly DeviceOrientation[];

/**
 * The four interface orientations clockwise. An iPhone Duo without a known
 * observed physical pose rotates in this order, as Xcode's Device Hub and
 * serve-sim turn it. An ordinary iPhone with a known observed pose also uses
 * this order, by physical names, so its interface commands step in
 * {@link DEVICE_ORIENTATIONS} order.
 */
export const CLOCKWISE_ORIENTATIONS = [
  "portrait",
  "landscape_right",
  "portrait_upside_down",
  "landscape_left",
] as const satisfies readonly DeviceOrientation[];

/**
 * The physical orientation of the device for each interface orientation. As in
 * UIKit, a landscape interface is the opposite physical landscape.
 */
const PHYSICAL_ORIENTATIONS: Readonly<Record<DeviceOrientation, HingePhysicalOrientation>> = {
  portrait: "portrait",
  landscape_right: "landscape-left",
  portrait_upside_down: "pud",
  landscape_left: "landscape-right",
};

/** The physical orientation that shows `orientation`. */
export function physicalOrientationForInterface(
  orientation: DeviceOrientation,
): HingePhysicalOrientation {
  return PHYSICAL_ORIENTATIONS[orientation];
}

// The same clockwise order, physically. serve-sim's rotation tracker
// (`src/client/simulator/duo-rotation-state.ts`, serve-sim at ace59bf34, #385)
// counts physical quarter turns in this order, so a quarter turn between two
// interface orientations is also one between their physical orientations.
const CLOCKWISE_PHYSICAL_ORIENTATIONS = CLOCKWISE_ORIENTATIONS.map(physicalOrientationForInterface);

/**
 * The physical orientation `quarterTurns` clockwise from `start`, as serve-sim's
 * rotation tracker counts them. Undefined when `start` is not upright, for
 * example face up.
 */
export function turnedPhysicalOrientation(
  start: HingePhysicalOrientation | undefined,
  quarterTurns: number,
): HingePhysicalOrientation | undefined {
  const index = start === undefined ? -1 : CLOCKWISE_PHYSICAL_ORIENTATIONS.indexOf(start);
  if (index < 0) return undefined;
  return CLOCKWISE_PHYSICAL_ORIENTATIONS[(((index + quarterTurns) % 4) + 4) % 4];
}

/** Quarter turns from one pose to another, clockwise positive, the shorter way for a half turn. */
export function clockwiseQuarterTurns(from: DeviceOrientation, to: DeviceOrientation): number {
  const steps = (CLOCKWISE_ORIENTATIONS.indexOf(to) - CLOCKWISE_ORIENTATIONS.indexOf(from) + 4) % 4;
  return steps === 3 ? -1 : steps;
}

/** The pose after `orientation` in `orientations`, or the first one when it is not listed. */
export function nextOrientation(
  orientation: DeviceOrientation,
  orientations: readonly DeviceOrientation[] = DEVICE_ORIENTATIONS,
): DeviceOrientation {
  return orientations[(orientations.indexOf(orientation) + 1) % orientations.length]!;
}

export function isLandscapeOrientation(orientation?: DeviceOrientation | null): boolean {
  return orientation === "landscape_left" || orientation === "landscape_right";
}

export function rotationDegreesForOrientation(orientation?: DeviceOrientation | null): number {
  switch (orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

/** Physical pose names exposed to the existing orientation controls. */
export function deviceOrientationForPose(
  pose?: HingePhysicalOrientation | null,
): DeviceOrientation | null {
  switch (pose) {
    case "portrait":
      return "portrait";
    case "pud":
      return "portrait_upside_down";
    case "landscape-left":
      return "landscape_left";
    case "landscape-right":
      return "landscape_right";
    default:
      return null;
  }
}

/** The legacy wire command names follow interface orientation, opposite physical landscape names. */
export function legacyOrientationForDeviceChoice(pose: DeviceOrientation): DeviceOrientation {
  return pose === "landscape_left"
    ? "landscape_right"
    : pose === "landscape_right"
      ? "landscape_left"
      : pose;
}

/**
 * The interface orientation of an observed config. When it is unknown, the raw
 * frame shape decides, as in the legacy rule of {@link streamGeometry}:
 * landscape pixels already face the framing, and portrait pixels are taken as
 * unturned content and turned to the framing.
 */
// @ref LLP 0016#screen — an unknown interface orientation maps pixels by the raw frame shape
function interfaceOrientation(config: ScreenSize): DeviceOrientation | undefined {
  if (config.screenOrientation) return config.screenOrientation;
  return config.width > config.height ? framingOrientation(config) : undefined;
}

function framingOrientation(config: ScreenSize): DeviceOrientation | undefined {
  if (config.deviceOrientation === undefined) return config.orientation;
  const physical = deviceOrientationForPose(config.deviceOrientation);
  return physical
    ? legacyOrientationForDeviceChoice(physical)
    : (config.screenOrientation ?? undefined);
}

/** The screen size as it should be *displayed* (width/height swapped for landscape). */
export function displayScreen(config?: ScreenSize | null): ScreenSize | null {
  if (!config || config.width <= 0 || config.height <= 0) return null;
  const orientation = framingOrientation(config);
  const observed = config.deviceOrientation !== undefined;
  const landscape =
    observed && orientation !== undefined
      ? isLandscapeOrientation(orientation)
      : isLandscapeOrientation(orientation) || config.width > config.height;
  const width = landscape
    ? Math.max(config.width, config.height)
    : Math.min(config.width, config.height);
  const height = landscape
    ? Math.min(config.width, config.height)
    : Math.max(config.width, config.height);
  if (
    width === config.width &&
    height === config.height &&
    (!observed || orientation === config.orientation)
  )
    return config;
  return { ...config, width, height, ...(observed ? { orientation } : {}) };
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
  if (config?.deviceOrientation !== undefined) {
    const frameRotation = rotationDegreesForOrientation(framingOrientation(config));
    const screenRotation = rotationDegreesForOrientation(interfaceOrientation(config));
    const pixelsRotation =
      config.framesUpright || (config.width > config.height && Math.abs(screenRotation) === 90)
        ? screenRotation
        : 0;
    const turn = (((frameRotation - pixelsRotation) % 360) + 360) % 360;
    const inputOrientation: DeviceOrientation | undefined =
      turn === 90
        ? "landscape_left"
        : turn === 180
          ? "portrait_upside_down"
          : turn === 270
            ? "landscape_right"
            : undefined;
    return {
      display,
      rotationDegrees: turn === 270 ? -90 : turn,
      needsRotation: turn !== 0,
      inputOrientation,
    };
  }
  const orientationRotation = rotationDegreesForOrientation(config?.orientation);
  const rotatesSideways = Math.abs(orientationRotation) === 90;
  const rawIsLandscape = !!config && config.width > config.height;
  const needsRotation =
    !config?.framesUpright && (orientationRotation === 180 || (rotatesSideways && !rawIsLandscape));
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
    case "landscape_left":
      return { x: y, y: 1 - x };
    case "landscape_right":
      return { x: 1 - y, y: x };
    case "portrait_upside_down":
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

/**
 * Rotate a *delta* vector (no translation) from display space into the raw
 * device orientation — the linear part of {@link rawPointForDisplayPoint}. Used
 * for scroll/pan deltas so they travel the right direction on rotated devices.
 */
export function rawDeltaForDisplayDelta(
  orientation: DeviceOrientation | null | undefined,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  switch (orientation) {
    case "landscape_left":
      return { dx: dy, dy: -dx };
    case "landscape_right":
      return { dx: -dy, dy: dx };
    case "portrait_upside_down":
      return { dx: -dx, dy: -dy };
    default:
      return { dx, dy };
  }
}

/** The inverse of {@link rawPointForDisplayPoint}: a raw frame point back to display space. */
export function displayPointForRawPoint(
  orientation: DeviceOrientation | null | undefined,
  x: number,
  y: number,
): { x: number; y: number } {
  switch (orientation) {
    case "landscape_left":
      return { x: 1 - y, y: x };
    case "landscape_right":
      return { x: y, y: 1 - x };
    case "portrait_upside_down":
      return { x: 1 - x, y: 1 - y };
    default:
      return { x, y };
  }
}

/** The inverse of {@link rawDeltaForDisplayDelta}. */
export function displayDeltaForRawDelta(
  orientation: DeviceOrientation | null | undefined,
  dx: number,
  dy: number,
): { dx: number; dy: number } {
  switch (orientation) {
    case "landscape_left":
      return { dx: -dy, dy: dx };
    case "landscape_right":
      return { dx: dy, dy: -dx };
    case "portrait_upside_down":
      return { dx: -dx, dy: -dy };
    default:
      return { dx, dy };
  }
}

/** Map a display-space HID edge to the raw-frame edge for the current orientation. */
export function rawEdgeForDisplayEdge(
  orientation: DeviceOrientation | null | undefined,
  edge: number,
): number {
  switch (orientation) {
    case "landscape_left":
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
    case "landscape_right":
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
    case "portrait_upside_down":
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
