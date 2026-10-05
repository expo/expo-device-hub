import { type DeviceStreamMode } from './types';

/** Preserve a supported viewer choice; prefer H.264 when falling back to HTTP. */
export function resolveDeviceStreamMode(
  requested: DeviceStreamMode,
  availability: Readonly<Record<DeviceStreamMode, boolean>>,
): DeviceStreamMode {
  if (availability[requested]) return requested;
  return (['h264', 'mjpeg', 'webrtc'] as const).find((mode) => availability[mode]) ?? requested;
}
