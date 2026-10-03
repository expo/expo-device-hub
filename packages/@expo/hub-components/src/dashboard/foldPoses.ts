import { type HingePose } from '@expo/hub-client';

/**
 * serve-sim's labels for the iPhone Duo's five presets. The stream toolbar
 * offers the first three; the inspector's Fold pose select lists them all.
 */
export const FOLD_POSE_OPTIONS: ReadonlyArray<{ value: HingePose; label: string }> = [
  { value: 'closed', label: 'Fully folded' },
  { value: 'book', label: 'Partially open' },
  { value: 'open', label: 'Fully open' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'tent', label: 'Tent' },
];

/** Keyboard shortcut digit of each preset: Option+Shift+1–5 in Xcode's Device Hub order. */
export const FOLD_POSE_SHORTCUTS: Record<HingePose, number> = {
  closed: 1,
  open: 2,
  laptop: 3,
  book: 4,
  tent: 5,
};

/**
 * The preset a fold control shows as selected. A reported pose wins, including
 * an explicit `null` for a custom angle; before any pose is reported the two
 * endpoints are inferred from the angle.
 */
export function selectedFoldPose(
  angle: number | undefined,
  pose: HingePose | null | undefined,
): HingePose | null {
  return pose !== undefined ? pose : angle === 0 ? 'closed' : angle === 180 ? 'open' : null;
}
