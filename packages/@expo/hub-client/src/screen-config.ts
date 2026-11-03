/**
 * Screen-config equality, ported from serve-sim's
 * `src/client/simulator/screen-config-state.ts` (@expo/serve-sim 0.5.0). The
 * helper pushes a new config on every change; comparing every field keeps a
 * hinge move or a display switch visible even when the pixel size is unchanged.
 */

import { observedHingeState } from "./hinge-control";
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
