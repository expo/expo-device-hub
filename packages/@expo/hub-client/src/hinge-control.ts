/**
 * iPhone Duo hinge control protocol, ported from serve-sim's `src/hinge-control.ts`.
 * Commands travel over the helper's input WebSocket (tag `0x10`, answered with `0x90`).
 */

/** Xcode 27.1 Device Hub's physical poses, in its keyboard shortcut order. */
export const HINGE_POSES = [
  { id: "closed", label: "Closed", angle: 0 },
  { id: "open", label: "Open", angle: 180 },
  { id: "laptop", label: "Laptop", angle: 90 },
  { id: "book", label: "Book", angle: 90 },
  { id: "tent", label: "Tent", angle: 80 },
] as const;

export type HingePose = (typeof HINGE_POSES)[number]["id"];

/** One hinge command: an angle, a pose preset, Table Mode, or face up/down. */
export type HingeControlCommand =
  | { control: "angle"; value: number }
  | { control: "pose"; value: HingePose }
  | { control: "table"; value: boolean }
  | { control: "physical"; value: "faceup" | "facedown" };

/** The device's physical (not app) orientation, as serve-sim reports it. */
export type HingePhysicalOrientation =
  | "portrait"
  | "pud"
  | "landscape-left"
  | "landscape-right"
  | "faceup"
  | "facedown";

/** serve-sim's native hinge observation, reported in the screen config. */
export interface ObservedHingeState {
  hingeAngle?: number;
  physicalOrientation?: HingePhysicalOrientation;
  tableMode?: boolean;
}

export function isHingeAngle(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 180;
}

export function isHingeControlCommand(value: unknown): value is HingeControlCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return command.control === "angle"
    ? isHingeAngle(command.value)
    : command.control === "physical"
      ? command.value === "faceup" || command.value === "facedown"
      : command.control === "table"
        ? typeof command.value === "boolean"
        : command.control === "pose" && HINGE_POSES.some((pose) => pose.id === command.value);
}

export function hingePoseOrientation(pose: HingePose): HingePhysicalOrientation {
  return pose === "laptop" ? "landscape-left" : pose === "tent" ? "facedown" : "portrait";
}

/** The preset that observed native state describes, whichever client produced it. */
export function observedHingePose(
  angle: number | undefined,
  orientation: HingePhysicalOrientation | undefined,
  tableMode: boolean | undefined,
): HingePose | null | undefined {
  if (angle === undefined || orientation === undefined || tableMode === undefined) return undefined;
  return (
    HINGE_POSES.find(
      (pose) =>
        Math.abs(pose.angle - angle) <= 0.5 &&
        hingePoseOrientation(pose.id) === orientation &&
        (pose.id === "tent") === tableMode,
    )?.id ?? null
  );
}

/** The helper's `0x90` reply to one hinge command. */
export interface HingeControlReply {
  requestId: number;
  ok: boolean;
  error?: string;
}

export function parseHingeControlReply(json: string): HingeControlReply | null {
  try {
    const reply = JSON.parse(json) as Record<string, unknown> | null;
    if (
      !reply ||
      typeof reply.requestId !== "number" ||
      typeof reply.ok !== "boolean" ||
      (reply.error !== undefined && typeof reply.error !== "string")
    )
      return null;
    return {
      requestId: reply.requestId,
      ok: reply.ok,
      ...(typeof reply.error === "string" ? { error: reply.error } : {}),
    };
  } catch {
    return null;
  }
}
