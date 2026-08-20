import { type DeviceStreamMode } from '@expo/hub-client';

export type Transport = DeviceStreamMode;

export const DEFAULT_TRANSPORT: Transport = 'mjpeg';
export const TRANSPORTS = ['mjpeg', 'h264', 'webrtc'] as const satisfies readonly Transport[];

export function parseTransport(value: unknown): Transport | undefined {
  return TRANSPORTS.includes(value as Transport) ? (value as Transport) : undefined;
}

declare global {
  interface Window {
    __EXPO_DEVICE_HUB_TRANSPORT__?: Transport;
  }
}

/** Transport selected by the standalone CLI, or MJPEG when none was provided. */
export function dashboardTransport(): Transport {
  if (typeof window === 'undefined') return DEFAULT_TRANSPORT;
  return parseTransport(window.__EXPO_DEVICE_HUB_TRANSPORT__) ?? DEFAULT_TRANSPORT;
}
