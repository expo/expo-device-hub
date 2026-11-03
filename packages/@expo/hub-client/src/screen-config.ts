/**
 * Screen-config equality, ported from serve-sim's
 * `src/client/simulator/screen-config-state.ts` (serve-sim at 3dc61286e, #383). The
 * helper pushes a new config on every change; comparing every field keeps a
 * hinge move or a display switch visible even when the pixel size is unchanged.
 */

import { type HingePhysicalOrientation, observedHingeState } from "./hinge-control";
import { type ScreenSize } from "./types";

export function screenConfigsEqual(a: ScreenSize | null, b: ScreenSize): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.screenId === b.screenId &&
    a.hingeAngle === b.hingeAngle &&
    a.supportsHingeAngle === b.supportsHingeAngle &&
    a.supportsPhysicalOrientation === b.supportsPhysicalOrientation &&
    a.hingePose === b.hingePose &&
    a.physicalOrientation === b.physicalOrientation &&
    a.tableMode === b.tableMode &&
    a.tableModeAvailable === b.tableModeAvailable &&
    a.inputUnavailable === b.inputUnavailable &&
    (a.observedDeviceState === undefined) === (b.observedDeviceState === undefined) &&
    a.observedDeviceState?.hingeAngle === b.observedDeviceState?.hingeAngle &&
    a.observedDeviceState?.physicalOrientation === b.observedDeviceState?.physicalOrientation &&
    a.observedDeviceState?.tableMode === b.observedDeviceState?.tableMode
  );
}

/**
 * The hinge state that the config shows, as serve-sim's `previewScreenConfig`
 * reads it: a native observation replaces the last command's fields, and a
 * field that it omits is unknown. A config without one is returned unchanged.
 */
export function observedScreenConfig(config: ScreenSize): ScreenSize {
  if (config.observedDeviceState === undefined) return config;
  return { ...config, ...observedHingeState(config.observedDeviceState) };
}

// serve-sim's rotation tracker counts physical quarter turns in this order.
const CLOCKWISE_PHYSICAL_ORIENTATIONS: readonly HingePhysicalOrientation[] = [
  "portrait",
  "landscape-left",
  "pud",
  "landscape-right",
];

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

/**
 * Whether a config shows that a local rotation reached the device. The helper
 * keeps the last command's pose in the top-level fields, so with a native
 * observation, the observation says it: the observed physical orientation is
 * the rotation's `target`. Another change, such as a pose command's own
 * readback, does not end the rotation. Without an observation, the cleared
 * command pose says it.
 */
export function isRotationReadback(
  config: ScreenSize,
  target: HingePhysicalOrientation | undefined,
): boolean {
  if (config.observedDeviceState === undefined) return config.hingePose === null;
  return target !== undefined && config.observedDeviceState.physicalOrientation === target;
}
