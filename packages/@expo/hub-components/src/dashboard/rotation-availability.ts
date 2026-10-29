import type { ConnectionStatus, DeviceScreenRecordingStatus } from "@expo/hub-client";

/**
 * Why Rotate and the Orientation select cannot turn the device now, or undefined when they can.
 * Both controls use this one rule: the client's recording lock first, then a live stream.
 */
export function rotationUnavailableReason({
  status,
  recording,
  recordingControlsLocked,
}: {
  status: ConnectionStatus;
  recording: DeviceScreenRecordingStatus | null;
  recordingControlsLocked: boolean;
}): string | undefined {
  if (recordingControlsLocked) {
    return recording === "unknown"
      ? "Rotation is unavailable until recording status is known."
      : "Rotation is unavailable while recording.";
  }
  if (status !== "streaming") return "Rotation is unavailable until the device stream is live.";
  return undefined;
}
