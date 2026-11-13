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
 * Whether the recording reported in a status has its own encode, apart from the live stream, so
 * that no rotation, stream change or fold ends it. Only an Android recording that the emulator
 * capture agent encodes reports it; an older server without the field keeps the lock.
 */
export function screenRecordingIndependent(value: unknown): boolean {
  return (
    !!value && typeof value === "object" && "independent" in value && value.independent === true
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

/**
 * Why a rotation or stream change could end a recording with this status, or null. An
 * independent recording has its own encode, so nothing that the client changes can end it.
 */
export function recordingLockReason(
  status: DeviceScreenRecordingStatus | null,
  independent = false,
): DeviceRecordingLockReason | null {
  switch (status) {
    case "unknown":
      return "status-unknown";
    case "waiting":
    case "recording":
    case "finalizing":
      return independent ? null : "recording";
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
