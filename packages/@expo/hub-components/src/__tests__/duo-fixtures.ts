import { type DeviceFoldCapabilities, type FoldPose } from "@expo/hub-client";

import { duoPresetView } from "../foldable/duo-view";

/** The iPhone Duo's fold controls, as `@expo/hub-client` reports them for serve-sim. */
export const DUO_FOLD_CONTROLS: Exclude<DeviceFoldCapabilities, false> = {
  angle: { min: 0, max: 180 },
  poses: {
    closed: { angle: 0 },
    open: { angle: 180 },
    laptop: { angle: 90 },
    book: { angle: 90 },
    tent: { angle: 80 },
  },
  tableMode: true,
  faceDown: true,
};

/** A preset's view at the Duo's angle for that pose. */
export function duoPreset(pose: FoldPose) {
  return duoPresetView(pose, DUO_FOLD_CONTROLS.poses[pose]!.angle);
}
