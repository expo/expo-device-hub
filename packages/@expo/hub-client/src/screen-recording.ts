import type { DeviceScreenRecordingStatus } from './backend-client';
import { type DeviceClient, type ScreenRecordingPhase } from './types';

export function parseScreenRecordingStatus(value: unknown): DeviceScreenRecordingStatus | null {
  if (!value || typeof value !== 'object' || !('status' in value)) return null;
  switch (value.status) {
    case 'waiting':
    case 'recording':
    case 'finalizing':
    case 'complete':
    case 'failed':
      return value.status;
    default:
      return null;
  }
}

const LOCKED_PHASES: ReadonlySet<ScreenRecordingPhase> = new Set([
  'waiting',
  'recording',
  'finalizing',
]);

/**
 * Whether controls that would interrupt a host recording stay locked. Until
 * the recording feature has a phase (resolving, loading, or failed reads) the
 * controls stay locked; a backend without recording never locks them.
 */
export function areRecordingControlsLocked(
  recording: DeviceClient['screenRecording'] | undefined,
): boolean {
  if (!recording || recording.status === 'unsupported') return false;
  return recording.data === undefined || LOCKED_PHASES.has(recording.data);
}
