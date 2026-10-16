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

/** Requested control preview, separate from observed native state. */
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

/** The preset that observed native state describes, whichever client produced it. */
export function observedHingePose(angle: number | undefined, orientation: HingePhysicalOrientation | undefined,
  tableMode: boolean | undefined): HingePose | null | undefined {
  if (angle === undefined || orientation === undefined || tableMode === undefined) return undefined;
  return HINGE_POSES.find((pose) => Math.abs(pose.angle - angle) <= 0.5 &&
    hingePoseOrientation(pose.id) === orientation && (pose.id === "tent") === tableMode)?.id ?? null;
}

/** Native observation has reached every field that a local preview sets. */
export function isHingePreviewObserved(preview: HingeControlState,
  observed: HingeControlState & { physicalOrientation?: HingePhysicalOrientation }): boolean {
  return (preview.hingeAngle === undefined ||
      (observed.hingeAngle !== undefined && Math.abs(observed.hingeAngle - preview.hingeAngle) <= 1)) &&
    (!preview.hingePose || observed.physicalOrientation === hingePoseOrientation(preview.hingePose)) &&
    (preview.tableMode === undefined || observed.tableMode === preview.tableMode);
}

/** Device Hub gates Table Mode by hinge state and physical (not app) orientation. */
export function isTableModeAvailable(angle: number | undefined, orientation: HingePhysicalOrientation | undefined): boolean {
  if (angle === undefined || orientation === undefined) return false;
  if (angle === 0) return orientation === "landscape-left" || orientation === "landscape-right";
  if (angle === 180) return orientation === "portrait";
  return orientation !== "faceup";
}
