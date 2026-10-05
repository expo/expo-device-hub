import { type HingePose } from '@expo/hub-client';

/** serve-sim's labels for the iPhone Duo's five presets, listed by the inspector's Fold pose select. */
export const FOLD_POSE_OPTIONS: ReadonlyArray<{ value: HingePose; label: string }> = [
  { value: 'closed', label: 'Fully folded' },
  { value: 'book', label: 'Partially open' },
  { value: 'open', label: 'Fully open' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'tent', label: 'Tent' },
];

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
