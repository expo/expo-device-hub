import type { DeviceRecordingLockReason } from "@expo/hub-client";

/** What a locked control says while the session records, when a change would cut the recording. */
export const RECORDING_INTERRUPT_REASON = "Unavailable because this would interrupt the recording.";

/** What a locked control says while the session records, when the control comes back afterwards. */
export const RECORDING_FINISH_REASON = "Unavailable until recording finishes.";

/**
 * The explanation that a control shows while a session recording locks it, or
 * undefined when it is not locked. `whileRecording` is the text for a session
 * that records; the text for an unknown recording status is always the same.
 */
export function recordingLockText(
  lock: DeviceRecordingLockReason | null | undefined,
  whileRecording = RECORDING_INTERRUPT_REASON,
): string | undefined {
  if (lock === null || lock === undefined) return undefined;
  return lock === "status-unknown"
    ? "Unavailable until recording status is known."
    : whileRecording;
}
