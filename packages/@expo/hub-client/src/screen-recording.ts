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

/**
 * Whether the recording reported in a status keeps going when the device folds. Only an Android
 * recording of a foldable that serve-emu encodes on a fixed canvas reports it.
 */
export function screenRecordingFollowsFold(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && "followsFold" in value && value.followsFold === true
  );
}

/**
 * Why a fold could end the recording, or null: the recording lock, unless the recording reports
 * that it follows folds.
 */
export function foldRecordingLock(
  lock: DeviceRecordingLockReason | null,
  followsFold: boolean,
): DeviceRecordingLockReason | null {
  return lock === "recording" && followsFold ? null : lock;
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
