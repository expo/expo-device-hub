import type { StreamConfig } from "../types.js";

export type ScreenConfigSource = "external" | "media" | "reported";

export interface ScreenConfigUpdate {
  config: StreamConfig;
  notifyParent: boolean;
}

export function screenConfigsEqual(a: StreamConfig | null, b: StreamConfig): boolean {
  return !!a && a.width === b.width && a.height === b.height &&
    a.orientation === b.orientation && a.screenId === b.screenId && a.hingeAngle === b.hingeAngle &&
    a.supportsHingeAngle === b.supportsHingeAngle && a.hingePose === b.hingePose &&
    a.tableMode === b.tableMode && a.tableModeAvailable === b.tableModeAvailable;
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
  if (config.hingeAngle === undefined && prev?.hingeAngle !== undefined) {
    next.hingeAngle = prev.hingeAngle;
  }
  if (screenConfigsEqual(prev, next)) {
    return null;
  }
  return {
    config: next,
    notifyParent: source !== "external",
  };
}
