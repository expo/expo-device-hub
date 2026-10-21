/**
 * The fold vocabulary that every foldable device shares. Each backend adapter
 * maps its own protocol onto it: serve-sim's hinge commands for the iPhone
 * Duo, serve-emu's `/api/fold` for an Android emulator.
 */

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
 * `DeviceFoldCapabilities` offers it: `angle`, a pose in `poses`, `tableMode`,
 * or `faceDown`.
 */
export type FoldControlCommand =
  /** Move the hinge to an angle in degrees, inside `capabilities.fold.angle`. */
  | { control: "angle"; value: number }
  /** Apply a named pose: its hinge angle, and on iOS also its physical stance. */
  | { control: "pose"; value: FoldPose }
  /** Turn the device's persistent table state on or off (Xcode's Table Mode). */
  | { control: "tableMode"; value: boolean }
  /** Lay the device face down or face up without moving the hinge. */
  | { control: "faceDown"; value: boolean };
