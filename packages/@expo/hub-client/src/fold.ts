/**
 * The fold vocabulary that every foldable device shares. Each backend adapter
 * maps its own protocol onto it: serve-sim's hinge commands for the iPhone
 * Duo, serve-emu's `/api/fold` for an Android emulator.
 */

import { type DeviceFoldCapabilities } from "./types";

/**
 * Named poses of a foldable device, in Option+Shift+1–5 order (the order of
 * Xcode Device Hub's pose shortcuts). A device offers a subset, listed in
 * `DeviceFoldCapabilities.poses`.
 *
 * - `closed`: folded shut; the cover display is in use.
 * - `open`: unfolded flat; the inner display is in use.
 * - `laptop`: half open on a table, with a horizontal hinge.
 * - `book`: half open in the hand, with a vertical hinge.
 * - `tent`: half open, standing on its two outer edges.
 */
export const FOLD_POSES = ["closed", "open", "laptop", "book", "tent"] as const;

export type FoldPose = (typeof FOLD_POSES)[number];

/**
 * A fold command. A device accepts a control only when its
 * `DeviceFoldCapabilities` offers it: `angle`, a pose in `poses`, or
 * `tableMode`.
 */
export type FoldControlCommand =
  /** Move the hinge to an angle in degrees, inside `capabilities.fold.angle`. */
  | { control: "angle"; value: number }
  /** Apply a named pose: its hinge angle, and on iOS also its physical stance. */
  | { control: "pose"; value: FoldPose }
  /** Turn the device's persistent table state on or off (Xcode's Table Mode). */
  | { control: "tableMode"; value: boolean };

/** Whether `capabilities` offer `command`: its control, its pose, or its angle inside the range. */
export function foldCommandOffered(
  capabilities: DeviceFoldCapabilities,
  command: FoldControlCommand,
): boolean {
  if (!capabilities) return false;
  switch (command.control) {
    case "angle":
      return (
        capabilities.angle !== false &&
        command.value >= capabilities.angle.min &&
        command.value <= capabilities.angle.max
      );
    case "pose":
      return capabilities.poses[command.value] !== undefined;
    case "tableMode":
      return capabilities.tableMode;
  }
}
