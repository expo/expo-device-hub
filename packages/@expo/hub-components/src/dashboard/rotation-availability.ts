import type { DeviceOrientationUnavailableReason } from "@expo/hub-client";

/**
 * The explanation that Rotate and the Orientation select show for the client's
 * `orientationUnavailable`, or undefined when they can turn the device.
 */
export function rotationUnavailableText(
  reason: DeviceOrientationUnavailableReason | null,
): string | undefined {
  switch (reason) {
    case null:
      return undefined;
    case "recording-status-unknown":
      return "Rotation is unavailable until recording status is known.";
    case "recording":
      return "Rotation is unavailable while recording.";
    case "not-streaming":
      return "Rotation is unavailable until the simulator stream is live.";
  }
}
