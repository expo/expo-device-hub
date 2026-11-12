/**
 * serve-sim's screen config and its equality, ported from serve-sim's
 * `src/client/simulator/screen-config-state.ts` (serve-sim at 3dc61286e, #383). The
 * helper pushes a new config on every change; comparing every field keeps a
 * hinge move or a display switch visible even when the pixel size is unchanged.
 * The config stays inside the iOS adapter, which publishes only the
 * platform-neutral {@link ScreenSize}.
 */

import { duoDisplayId } from "./duo/duo-fold";
import {
  type HingeControlState,
  type HingePhysicalOrientation,
  type ObservedHingeState,
  observedHingeState,
} from "./hinge-control";
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
  /** Native hinge snapshot. It also reports a fold made with the Simulator's own controls. */
  observedDeviceState?: ObservedHingeState;
}

export function screenConfigsEqual(a: SimScreenConfig | null, b: SimScreenConfig): boolean {
  return (
    !!a &&
    a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.screenOrientation === b.screenOrientation &&
    a.deviceOrientation === b.deviceOrientation &&
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
export function observedScreenConfig(config: SimScreenConfig): SimScreenConfig {
  if (config.observedDeviceState === undefined) return config;
  return { ...config, ...observedHingeState(config.observedDeviceState) };
}

/**
 * Whether a config shows that a local rotation reached the device. The helper
 * keeps the last command's pose in the top-level fields, so with a native
 * observation, the observation says it: the observed physical orientation is
 * the rotation's `target`. Another change, such as a pose command's own
 * readback, does not end the rotation. Without an observation, the cleared
 * command pose says it. The target follows serve-sim's rotation tracker
 * (`duo-rotation-state.ts`, serve-sim at ace59bf34, #385).
 */
export function isRotationReadback(
  config: SimScreenConfig,
  target: HingePhysicalOrientation | undefined,
): boolean {
  if (config.observedDeviceState === undefined) return config.hingePose === null;
  return target !== undefined && config.observedDeviceState.physicalOrientation === target;
}

/**
 * The public screen of a serve-sim config. Only a foldable names its display,
 * because the screen ID of an ordinary iPhone says nothing about a fold.
 */
export function simScreenSize(config: SimScreenConfig, foldable: boolean): ScreenSize {
  const screen: ScreenSize = { width: config.width, height: config.height };
  if (config.orientation !== undefined) screen.orientation = config.orientation;
  if (!foldable && config.supportsHingeAngle === false) {
    if (config.screenOrientation !== undefined) screen.screenOrientation = config.screenOrientation;
    if (config.deviceOrientation !== undefined) {
      screen.deviceOrientation = config.deviceOrientation;
      screen.orientation = config.screenOrientation ?? undefined;
    }
  }
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
      a.screenOrientation === b.screenOrientation &&
      a.deviceOrientation === b.deviceOrientation &&
      a.inputUnavailable === b.inputUnavailable &&
      a.display === b.display)
  );
}
