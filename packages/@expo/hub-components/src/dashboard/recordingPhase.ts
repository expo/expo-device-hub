import type { DeviceClient, DeviceScreenRecordingStatus } from '@expo/hub-client';

/** Keep recording controls locked until the host has answered. */
export function recordingPhase(
  feature: DeviceClient['screenRecording'] | undefined,
): DeviceScreenRecordingStatus | null {
  if (!feature || feature.status === 'unsupported') return null;
  return feature.data ?? 'unknown';
}
