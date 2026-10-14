import type { StreamConfig } from "../types.js";
import { isTableModeAvailable, observedHingePose } from "../../hinge-control";

export type ScreenConfigSource = "external" | "media" | "reported";

export interface ScreenConfigUpdate {
  config: StreamConfig;
  notifyParent: boolean;
}

export function screenConfigsEqual(a: StreamConfig | null, b: StreamConfig): boolean {
  return !!a && a.width === b.width && a.height === b.height &&
    a.orientation === b.orientation && a.screenId === b.screenId && a.hingeAngle === b.hingeAngle &&
    a.supportsHingeAngle === b.supportsHingeAngle &&
    a.supportsPhysicalOrientation === b.supportsPhysicalOrientation && a.hingePose === b.hingePose &&
    a.physicalOrientation === b.physicalOrientation &&
    a.tableMode === b.tableMode && a.tableModeAvailable === b.tableModeAvailable &&
    a.inputUnavailable === b.inputUnavailable &&
    (a.observedDeviceState === undefined) === (b.observedDeviceState === undefined) &&
    a.observedDeviceState?.hingeAngle === b.observedDeviceState?.hingeAngle &&
    a.observedDeviceState?.physicalOrientation === b.observedDeviceState?.physicalOrientation &&
    a.observedDeviceState?.tableMode === b.observedDeviceState?.tableMode;
}

export function resolveScreenConfigUpdate(
  prev: StreamConfig | null,
  config: StreamConfig | null | undefined,
  source: ScreenConfigSource,
): ScreenConfigUpdate | null {
  if (!config || config.width <= 0 || config.height <= 0) return null;
  const next = { ...prev, ...config };
  if (config.orientation === undefined && prev?.orientation !== undefined) {
    next.orientation = prev.orientation;
  }
  if (source === "media" && config.hingeAngle === undefined && prev?.hingeAngle !== undefined) {
    next.hingeAngle = prev.hingeAngle;
  }
  if (source !== "media") {
    if (config.observedDeviceState === undefined) delete next.observedDeviceState;
    if (config.hingeAngle === undefined) delete next.hingeAngle;
    if (config.hingePose === undefined) delete next.hingePose;
    if (config.physicalOrientation === undefined) delete next.physicalOrientation;
    if (config.tableMode === undefined) delete next.tableMode;
    if (config.tableModeAvailable === undefined) delete next.tableModeAvailable;
    if (config.supportsHingeAngle === undefined) delete next.supportsHingeAngle;
    if (config.supportsPhysicalOrientation === undefined) delete next.supportsPhysicalOrientation;
  }
  if (screenConfigsEqual(prev, next)) {
    return null;
  }
  return {
    config: next,
    notifyParent: source !== "external",
  };
}

/** Native snapshots own preview pose; omitted fields clear saved command state. */
export function previewScreenConfig(config: StreamConfig): StreamConfig {
  if (config.observedDeviceState === undefined) return config;
  const { hingeAngle, physicalOrientation, tableMode } = config.observedDeviceState;
  return {
    ...config,
    hingeAngle,
    physicalOrientation,
    tableMode,
    hingePose: observedHingePose(hingeAngle, physicalOrientation, tableMode),
    tableModeAvailable: isTableModeAvailable(hingeAngle, physicalOrientation),
  };
}
