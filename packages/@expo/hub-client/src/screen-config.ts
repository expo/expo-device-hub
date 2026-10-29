/**
 * Screen-config equality, ported from serve-sim's
 * `src/client/simulator/screen-config-state.ts`. The helper pushes a new config on
 * every change; comparing every field keeps a hinge move or a display switch visible
 * even when the pixel size is unchanged.
 */

import {
  type HingePhysicalOrientation,
  type HingePose,
  isTableModeAvailable,
  observedHingePose,
} from "./hinge-control";
import { type ScreenSize } from "./types";

export function screenConfigsEqual(a: ScreenSize | null, b: ScreenSize): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.screenId === b.screenId &&
    a.supportsHingeAngle === b.supportsHingeAngle &&
    a.supportsPhysicalOrientation === b.supportsPhysicalOrientation &&
    a.hingeAngle === b.hingeAngle &&
    a.hingePose === b.hingePose &&
    a.physicalOrientation === b.physicalOrientation &&
    a.tableMode === b.tableMode &&
    a.tableModeAvailable === b.tableModeAvailable &&
    (a.observedDeviceState === undefined) === (b.observedDeviceState === undefined) &&
    a.observedDeviceState?.hingeAngle === b.observedDeviceState?.hingeAngle &&
    a.observedDeviceState?.physicalOrientation === b.observedDeviceState?.physicalOrientation &&
    a.observedDeviceState?.tableMode === b.observedDeviceState?.tableMode
  );
}

/**
 * The hinge state a client shows. serve-sim's native observation wins over its last
 * successful command, and fields that the observation omits are unknown.
 */
export function screenHingeState(screen: ScreenSize): {
  angle?: number;
  pose?: HingePose | null;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
} {
  const observed = screen.observedDeviceState;
  if (!observed) {
    return {
      angle: screen.hingeAngle,
      pose: screen.hingePose,
      physicalOrientation: screen.physicalOrientation,
      tableMode: screen.tableMode,
      tableModeAvailable: screen.tableModeAvailable,
    };
  }
  // As in serve-sim's `observedHingeState`, availability follows the observed state.
  return {
    angle: observed.hingeAngle,
    pose: observedHingePose(observed.hingeAngle, observed.physicalOrientation, observed.tableMode),
    physicalOrientation: observed.physicalOrientation,
    tableMode: observed.tableMode,
    tableModeAvailable: isTableModeAvailable(observed.hingeAngle, observed.physicalOrientation),
  };
}
