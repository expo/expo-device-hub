import { isHingeAngle } from "./hinge-angle";

/** Xcode 27.1 Device Hub's physical poses, in its keyboard shortcut order. */
export const HINGE_POSES = [
  { id: "closed", label: "Closed", angle: 0 },
  { id: "open", label: "Open", angle: 180 },
  { id: "laptop", label: "Laptop", angle: 90 },
  { id: "book", label: "Book", angle: 90 },
  { id: "tent", label: "Tent", angle: 80 },
] as const;

export type HingePose = typeof HINGE_POSES[number]["id"];
export type HingeControlCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: HingePose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" };

export function isHingeControlCommand(value: unknown): value is HingeControlCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return command.control === "angle" ? isHingeAngle(command.value)
    : command.control === "physical" ? command.value === "faceup" || command.value === "facedown"
    : command.control === "table" ? typeof command.value === "boolean"
    : command.control === "pose" && HINGE_POSES.some((pose) => pose.id === command.value);
}

/** Confirmed command state, separate from the app's reported screen orientation. */
export function hingeControlState(command: HingeControlCommand): HingeControlState {
  if (command.control === "physical") return { hingePose: null, tableMode: command.value === "facedown" };
  if (command.control === "table") return { tableMode: command.value, hingePose: null };
  if (command.control === "angle") return { hingeAngle: command.value, hingePose: null, tableMode: false };
  const pose = HINGE_POSES.find((pose) => pose.id === command.value)!;
  return { hingeAngle: pose.angle, hingePose: pose.id, tableMode: pose.id === "tent" };
}


export type HingeControlState = {
  hingeAngle?: number;
  hingePose?: HingePose | null;
  tableMode?: boolean;
  tableModeAvailable?: boolean;
};

export type HingePhysicalOrientation = "portrait" | "pud" | "landscape-left" | "landscape-right" | "faceup" | "facedown";

export function hingePoseOrientation(pose: HingePose): HingePhysicalOrientation {
  return pose === "laptop" ? "landscape-left" : pose === "tent" ? "facedown" : "portrait";
}

/** Name the preset that matches native state, so a new session shows the same pose. */
export function hingePoseForState(state: { hingeAngle?: number; physicalOrientation?: HingePhysicalOrientation; tableMode?: boolean }): HingePose | null {
  if (state.hingeAngle === 0) return "closed";
  if (state.hingeAngle === 180) return "open";
  return HINGE_POSES.find((pose) => pose.angle === state.hingeAngle &&
    hingePoseOrientation(pose.id) === state.physicalOrientation &&
    (pose.id === "tent") === (state.tableMode === true))?.id ?? null;
}

/** Device Hub gates Table Mode by hinge state and physical (not app) orientation. */
export function isTableModeAvailable(angle: number | undefined, orientation: HingePhysicalOrientation | undefined): boolean {
  if (angle === undefined || orientation === undefined) return false;
  if (angle === 0) return orientation === "landscape-left" || orientation === "landscape-right";
  if (angle === 180) return orientation === "portrait";
  return orientation !== "faceup";
}
