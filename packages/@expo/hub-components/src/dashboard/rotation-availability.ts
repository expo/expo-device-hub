import type {
  ConnectionStatus,
  DevicePlatform,
  DeviceScreenRecordingStatus,
} from "@expo/hub-client";

/**
 * Why Rotate and the Orientation select cannot turn the device now, or undefined when they can.
 * Both controls use this one rule: the client's recording lock first. Then, on iOS only, a live
 * stream: iOS sends the pose over the helper's input socket, which drops queued input after
 * 1.5 s. Android sends it over HTTP (`POST /api/orientation`), which works without the stream.
 */
export function rotationUnavailableReason({
  platform,
  status,
  recording,
  recordingControlsLocked,
}: {
  platform?: DevicePlatform;
  status: ConnectionStatus;
  recording: DeviceScreenRecordingStatus | null;
  recordingControlsLocked: boolean;
}): string | undefined {
  if (recordingControlsLocked) {
    return recording === "unknown"
      ? "Rotation is unavailable until recording status is known."
      : "Rotation is unavailable while recording.";
  }
  if (platform === "ios" && status !== "streaming") {
    return "Rotation is unavailable until the simulator stream is live.";
  }
  return undefined;
}
