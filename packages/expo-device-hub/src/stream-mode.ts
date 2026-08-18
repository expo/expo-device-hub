import { type DeviceStreamMode } from '@expo/hub-client';

export type StreamMode = DeviceStreamMode;

export const DEFAULT_STREAM_MODE: StreamMode = 'mjpeg';
export const STREAM_MODES = ['mjpeg', 'h264', 'webrtc'] as const satisfies readonly StreamMode[];

export function parseStreamMode(value: unknown): StreamMode | undefined {
  return STREAM_MODES.includes(value as StreamMode) ? (value as StreamMode) : undefined;
}

declare global {
  interface Window {
    __EXPO_DEVICE_HUB_STREAM_MODE__?: StreamMode;
  }
}

/** Stream mode selected by the standalone CLI, or MJPEG when none was provided. */
export function dashboardStreamMode(): StreamMode {
  if (typeof window === 'undefined') return DEFAULT_STREAM_MODE;
  return parseStreamMode(window.__EXPO_DEVICE_HUB_STREAM_MODE__) ?? DEFAULT_STREAM_MODE;
}
