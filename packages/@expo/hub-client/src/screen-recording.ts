import { type DeviceScreenRecordingStatus } from "./types";

export function parseScreenRecordingStatus(value: unknown): DeviceScreenRecordingStatus | null {
  if (!value || typeof value !== "object" || !("status" in value)) return null;
  switch (value.status) {
    case "waiting":
    case "recording":
    case "finalizing":
    case "complete":
    case "failed":
      return value.status;
    default:
      return null;
  }
}

/**
 * True while a recording status could end with a rotation or stream change.
 *
 * @deprecated Read `DeviceClient.recordingControlsLocked`, which also ignores the locked controls.
 */
export function areRecordingControlsLocked(status: DeviceScreenRecordingStatus | null): boolean {
  return (
    status === "unknown" ||
    status === "waiting" ||
    status === "recording" ||
    status === "finalizing"
  );
}
