import { type DeviceFoldCapabilities, FOLD_POSES, type FoldPose } from "@expo/hub-client";

/**
 * serve-sim's labels for the five fold poses, listed by the inspector's Fold
 * pose select. The shortcut is the pose's place in `FOLD_POSES`, which
 * `useDeviceKeyboard` reads.
 */
export const FOLD_POSE_OPTIONS: ReadonlyArray<{
  value: FoldPose;
  label: string;
  shortcut: string;
}> = (
  [
    { value: "closed", label: "Fully folded" },
    { value: "book", label: "Partially open" },
    { value: "open", label: "Fully open" },
    { value: "laptop", label: "Laptop" },
    { value: "tent", label: "Tent" },
  ] as const
).map((option) => ({ ...option, shortcut: `⌥⇧${FOLD_POSES.indexOf(option.value) + 1}` }));

/**
 * The preset a fold control shows as selected. A reported pose wins, including
 * an explicit `null` for a custom angle; before any pose is reported the two
 * endpoints that the device offers are inferred from the angle.
 */
export function selectedFoldPose(
  angle: number | undefined,
  pose: FoldPose | null | undefined,
  poses: Exclude<DeviceFoldCapabilities, false>["poses"],
): FoldPose | null {
  if (pose !== undefined) return pose;
  if (angle === undefined) return null;
  return angle === poses.closed?.angle ? "closed" : angle === poses.open?.angle ? "open" : null;
}
