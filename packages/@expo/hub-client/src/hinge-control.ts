/**
 * iPhone Duo hinge control protocol, ported from serve-sim's `src/hinge-control.ts`
 * (serve-sim at 3dc61286e, #383). The iOS adapter maps the public fold commands of
 * `./fold.ts` onto these wire commands, which travel over the helper's input
 * WebSocket (tag `0x10`, acknowledged with `0x90`). Nothing here is public.
 */

import { FOLD_POSES, type FoldControlCommand, type FoldPose } from "./fold";

/** Xcode 27.1 Device Hub's hinge angle for each iPhone Duo pose. */
export const DUO_POSE_ANGLES: Readonly<Record<FoldPose, number>> = {
  closed: 0,
  open: 180,
  laptop: 90,
  book: 90,
  tent: 80,
};

/** serve-sim's hinge command, as the helper reads it. */
export type HingeControlCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: FoldPose }
  | { control: "table"; value: boolean };

export function hingeWireCommand(command: FoldControlCommand): HingeControlCommand {
  return command.control === "tableMode" ? { control: "table", value: command.value } : command;
}

/** Confirmed command state, separate from the app's reported screen orientation. */
export function hingeControlState(command: FoldControlCommand): HingeControlState {
  if (command.control === "tableMode") return { tableMode: command.value, hingePose: null };
  if (command.control === "angle") {
    return { hingeAngle: command.value, hingePose: null, tableMode: false };
  }
  return {
    hingeAngle: DUO_POSE_ANGLES[command.value],
    hingePose: command.value,
    tableMode: command.value === "tent",
  };
}

export type HingeControlState = {
  hingeAngle?: number;
  hingePose?: FoldPose | null;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
};

export type HingePhysicalOrientation =
  | "portrait"
  | "pud"
  | "landscape-left"
  | "landscape-right"
  | "faceup"
  | "facedown";

export function hingePoseOrientation(pose: FoldPose): HingePhysicalOrientation {
  return pose === "laptop" ? "landscape-left" : pose === "tent" ? "facedown" : "portrait";
}

/** serve-sim's native hinge observation; a field that the native reader omits is unknown. */
export type ObservedHingeState = {
  hingeAngle?: number;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
};

/** serve-sim names an observed preset when its angle is within half a degree. */
const OBSERVED_POSE_ANGLE_TOLERANCE = 0.5;

/** The preset that observed native state describes, whichever client produced it. */
export function observedHingePose(
  angle: number | undefined,
  orientation: HingePhysicalOrientation | undefined,
  tableMode: boolean | undefined,
): FoldPose | null | undefined {
  if (angle === undefined || orientation === undefined || tableMode === undefined) return undefined;
  return (
    FOLD_POSES.find(
      (pose) =>
        Math.abs(DUO_POSE_ANGLES[pose] - angle) <= OBSERVED_POSE_ANGLE_TOLERANCE &&
        hingePoseOrientation(pose) === orientation &&
        (pose === "tent") === tableMode,
    ) ?? null
  );
}

/** Native observations replace command state, including fields the native reader omits. */
export function observedHingeState(state: ObservedHingeState) {
  const { hingeAngle, physicalOrientation, tableMode } = state;
  return {
    hingeAngle,
    physicalOrientation,
    tableMode,
    hingePose: observedHingePose(hingeAngle, physicalOrientation, tableMode),
    tableModeAvailable:
      hingeAngle === undefined || physicalOrientation === undefined
        ? undefined
        : isTableModeAvailable(hingeAngle, physicalOrientation),
  };
}

/** Native observation has reached every field that a local preview sets. */
export function isHingePreviewObserved(
  preview: HingeControlState,
  observed: HingeControlState & { physicalOrientation?: HingePhysicalOrientation },
): boolean {
  return (
    (preview.hingeAngle === undefined ||
      (observed.hingeAngle !== undefined &&
        Math.abs(observed.hingeAngle - preview.hingeAngle) <= 1)) &&
    (!preview.hingePose ||
      observed.physicalOrientation === hingePoseOrientation(preview.hingePose)) &&
    (preview.tableMode === undefined || observed.tableMode === preview.tableMode)
  );
}

/** Device Hub gates Table Mode by hinge state and physical (not app) orientation. */
function isTableModeAvailable(angle: number, orientation: HingePhysicalOrientation): boolean {
  if (angle === 0) return orientation === "landscape-left" || orientation === "landscape-right";
  if (angle === 180) return orientation === "portrait";
  return orientation !== "faceup";
}
