import { useCallback, useState } from "react";

import { type FoldPreviewMode } from "./PhoneFrame";

/**
 * The preview mode that a device shows: the viewer's choice, or 2D for the device whose 3D model
 * failed. Give `mode` to `StreamPanel` and to the Device options, and `reportUnavailable` to
 * `StreamPanel` as `foldPreview.onUnavailable`. Everything that depends on the mode then reads
 * this one value, so a failed model leaves the consumer in the same state as a choice of 2D. The saved choice stays 3D: another device, a
 * reload, or a new choice of 3D (`retry`) tries the model again.
 */
// @ref LLP 0015#errors — a failed 3D model shows 2D as if it was chosen, for this device only
export function useModelPreviewMode(deviceId: string | null, chosen: FoldPreviewMode) {
  const [failedDevice, setFailedDevice] = useState<string | null>(null);
  // Forget the failure while the new device renders, not in an effect. A model that fails as it
  // mounts, for example without WebGL, reports from a child's effect, and that effect runs before
  // this component's: an effect here would then erase the report, and the preview would keep a
  // failed model.
  const [device, setDevice] = useState(deviceId);
  if (device !== deviceId) {
    setDevice(deviceId);
    setFailedDevice(null);
  }
  const failed = deviceId !== null && failedDevice === deviceId;
  const mode: FoldPreviewMode = chosen === "3d" && !failed ? "3d" : "2d";
  const reportUnavailable = useCallback(() => setFailedDevice(deviceId), [deviceId]);
  const retry = useCallback(() => setFailedDevice(null), []);
  return { mode, reportUnavailable, retry };
}
