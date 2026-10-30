/**
 * iPhone Duo hinge control protocol, ported from serve-sim's `src/hinge-control.ts`
 * (@expo/serve-sim 0.5.0). The iOS adapter maps the public fold commands of
 * `./fold.ts` onto these wire commands, which travel over the helper's input
 * WebSocket (tag `0x10`, acknowledged with `0x90`). Nothing here is public.
 */

import { type FoldControlCommand, type FoldPose } from "./fold";

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
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" };

export function hingeWireCommand(command: FoldControlCommand): HingeControlCommand {
  switch (command.control) {
    case "tableMode":
      return { control: "table", value: command.value };
    case "faceDown":
      return { control: "physical", value: command.value ? "facedown" : "faceup" };
    default:
      return command;
  }
}

/** Confirmed command state, separate from the app's reported screen orientation. */
export function hingeControlState(command: FoldControlCommand): HingeControlState {
  if (command.control === "faceDown") return { hingePose: null, tableMode: command.value };
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
