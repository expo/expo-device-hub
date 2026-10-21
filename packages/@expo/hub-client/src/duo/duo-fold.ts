/**
 * Which iPhone Duo display a fold elects, ported from serve-sim's
 * `src/client/simulator/duo-pose.ts` and `duo-hinge-commands.ts`
 * (@expo/serve-sim 0.5.0).
 */

import { type FoldControlCommand, type FoldPose } from "../fold";
import {
  hingeControlState,
  hingePoseOrientation,
  type HingePhysicalOrientation,
} from "../hinge-control";
import { type DeviceDisplayId } from "../types";

/** serve-sim's display ID of an iPhone Duo panel: 1 is the cover, 3 the inner display. */
export type DuoPanelId = 1 | 3;

// @ref LLP 0016#display-identity — serve-sim's display IDs stay inside the iOS adapter
export const DUO_DISPLAY_FOR_PANEL: Readonly<Record<DuoPanelId, DeviceDisplayId>> = {
  1: "cover",
  3: "inner",
};

export const DUO_PANEL_FOR_DISPLAY: Readonly<Record<DeviceDisplayId, DuoPanelId>> = {
  cover: 1,
  inner: 3,
};

/** The display a serve-sim screen ID names, or undefined for another ID. */
export function duoDisplayId(screenId: number | undefined): DeviceDisplayId | undefined {
  return screenId === 1 || screenId === 3 ? DUO_DISPLAY_FOR_PANEL[screenId] : undefined;
}

/** Another client turned the device over, so a remembered preset no longer describes it. */
export function duoPhysicalPoseChanged(
  pose: FoldPose | null | undefined,
  orientation: HingePhysicalOrientation | undefined,
): boolean {
  return !!pose && orientation !== undefined && hingePoseOrientation(pose) !== orientation;
}

/** Select the requested panel before native display metadata catches up. */
export function duoIntendedScreen(
  angle: number | undefined,
  physicalPose: FoldPose | null | undefined,
  nativeScreenId?: number,
  faceDown = false,
): DuoPanelId {
  if (angle === undefined) return nativeScreenId === 1 ? 1 : 3;
  if (angle <= 0) return 1;
  if (angle >= 180) return 3;
  // Face down with Table Mode elects the cover, as the native Tent pose does.
  if (physicalPose === "tent" || faceDown) return 1;
  // CoreSimulator keeps the cover active through 54° and activates the inner
  // display at 55°. Keep fractional angles between those boundaries on the
  // current panel, matching native display ownership during slider motion.
  if (angle <= 54) return 1;
  if (angle >= 55) return 3;
  return nativeScreenId === 3 ? 3 : 1;
}

/**
 * The panel that a submitted command makes active. Table Mode and face up/down
 * keep the active panel, and fractional angles in the native hysteresis band
 * keep whichever panel is already active, so neither can establish a departure.
 */
export function duoCommandScreen(
  command: FoldControlCommand,
  physicalPose?: FoldPose | null,
): DuoPanelId | undefined {
  if (command.control === "tableMode" || command.control === "faceDown") return undefined;
  if (command.control === "angle" && command.value > 54 && command.value < 55) return undefined;
  const { hingeAngle } = hingeControlState(command);
  return duoIntendedScreen(hingeAngle, command.control === "pose" ? command.value : physicalPose);
}
