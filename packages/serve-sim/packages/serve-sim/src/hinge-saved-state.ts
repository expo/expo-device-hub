import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isHingeAngle } from "./hinge-angle";
import type { HingePhysicalOrientation } from "./hinge-control";
import { stateDir } from "./state";

type SavedHingeState = {
  hingeAngle: number;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
};

const orientations = new Set<string>(["portrait", "pud", "landscape-left", "landscape-right", "faceup", "facedown"]);
const udidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function savedStateFile(udid: string): string | null {
  return udidPattern.test(udid) ? join(stateDir(), `hinge-${udid.toUpperCase()}.json`) : null;
}

export function readSavedHingeState(udid: string, nativeAngle: number | undefined): Omit<SavedHingeState, "hingeAngle"> | null {
  const file = savedStateFile(udid);
  if (!file || !isHingeAngle(nativeAngle)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const state = value as Record<string, unknown>;
    if (!isHingeAngle(state.hingeAngle) || Math.abs(state.hingeAngle - nativeAngle) > 0.01) return null;
    if (state.physicalOrientation !== undefined && !orientations.has(state.physicalOrientation as string)) return null;
    if (state.tableMode !== undefined && typeof state.tableMode !== "boolean") return null;
    return {
      ...(state.physicalOrientation !== undefined ? { physicalOrientation: state.physicalOrientation as HingePhysicalOrientation } : {}),
      ...(state.tableMode !== undefined ? { tableMode: state.tableMode } : {}),
    };
  } catch {
    return null;
  }
}

export function writeSavedHingeState(udid: string, state: { hingeAngle?: number; physicalOrientation?: HingePhysicalOrientation; tableMode?: boolean }): void {
  const file = savedStateFile(udid);
  if (!file) return;
  try {
    if (!isHingeAngle(state.hingeAngle)) {
      try { unlinkSync(file); } catch {}
      return;
    }
    mkdirSync(stateDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      hingeAngle: state.hingeAngle,
      ...(state.physicalOrientation !== undefined ? { physicalOrientation: state.physicalOrientation } : {}),
      ...(state.tableMode !== undefined ? { tableMode: state.tableMode } : {}),
    }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    console.error(`[hinge] Could not save state for ${udid}:`, error);
  }
}
