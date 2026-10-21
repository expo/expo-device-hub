/**
 * serve-sim's screen config and its equality, ported from serve-sim's
 * `src/client/simulator/screen-config-state.ts` (@expo/serve-sim 0.5.0). The
 * helper pushes a new config on every change; comparing every field keeps a
 * hinge move or a display switch visible even when the pixel size is unchanged.
 * The config stays inside the iOS adapter, which publishes only the
 * platform-neutral {@link ScreenSize}.
 */

import { duoDisplayId } from "./duo/duo-fold";
import { type HingeControlState, type HingePhysicalOrientation } from "./hinge-control";
import { type ScreenSize } from "./types";

/** serve-sim's `StreamConfig`: the size, the active display, and an iPhone Duo's hinge state. */
export interface SimScreenConfig extends Omit<ScreenSize, "display">, HingeControlState {
  /** Active simulator display: 1 is the Duo's cover, 3 its inner display. */
  screenId?: number;
  /** Whether this simulator exposes hinge angle control. */
  supportsHingeAngle?: boolean;
  /** Whether the active Duo surface can be selected without changing its hinge angle. */
  supportsPhysicalOrientation?: boolean;
  /** Last confirmed physical orientation, separate from the app's screen orientation. */
  physicalOrientation?: HingePhysicalOrientation;
}

export function screenConfigsEqual(a: SimScreenConfig | null, b: SimScreenConfig): boolean {
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
    a.inputUnavailable === b.inputUnavailable
  );
}

/**
 * The public screen of a serve-sim config. Only a foldable names its display,
 * because the screen ID of an ordinary iPhone says nothing about a fold.
 */
export function simScreenSize(config: SimScreenConfig, foldable: boolean): ScreenSize {
  const screen: ScreenSize = { width: config.width, height: config.height };
  if (config.orientation !== undefined) screen.orientation = config.orientation;
  if (config.inputUnavailable !== undefined) screen.inputUnavailable = config.inputUnavailable;
  const display = foldable ? duoDisplayId(config.screenId) : undefined;
  if (display) screen.display = display;
  return screen;
}

export function screenSizesEqual(a: ScreenSize | null, b: ScreenSize | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.width === b.width &&
      a.height === b.height &&
      a.orientation === b.orientation &&
      a.inputUnavailable === b.inputUnavailable &&
      a.display === b.display)
  );
}
