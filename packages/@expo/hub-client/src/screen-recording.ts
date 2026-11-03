import {
  type DeviceOrientationUnavailableReason,
  type DeviceRecordingLockReason,
  type DeviceScreenRecordingStatus,
} from "./types";

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

/** Why a rotation or stream change could end a recording with this status, or null. */
export function recordingLockReason(
  status: DeviceScreenRecordingStatus | null,
): DeviceRecordingLockReason | null {
  switch (status) {
    case "unknown":
      return "status-unknown";
    case "waiting":
    case "recording":
    case "finalizing":
      return "recording";
    default:
      return null;
  }
}

/** The orientation reason for a recording lock. */
export function recordingOrientationUnavailable(
  lock: DeviceRecordingLockReason | null,
): DeviceOrientationUnavailableReason | null {
  return lock === "status-unknown" ? "recording-status-unknown" : lock;
}

/**
 * True while a recording status could end with a rotation or stream change.
 *
 * @deprecated Read `DeviceClient.recordingLock`, which also ignores the locked controls.
 */
export function areRecordingControlsLocked(status: DeviceScreenRecordingStatus | null): boolean {
  return recordingLockReason(status) !== null;
}
