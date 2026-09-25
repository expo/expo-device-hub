import { type DeviceScreenRecordingStatus } from './types.js';

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

export function areRecordingControlsLocked(status: DeviceScreenRecordingStatus | null): boolean {
  return status === 'unknown' || status === 'waiting' || status === 'recording' || status === 'finalizing';
}
