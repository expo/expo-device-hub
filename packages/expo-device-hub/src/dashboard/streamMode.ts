import { type DeviceStreamMode } from '@expo/hub-client';

/** The Hub owns playback policy; hub-client always receives an explicit mode. */
export const DEFAULT_STREAM_MODE: DeviceStreamMode = 'h264';

export interface StreamEnvironment {
  protocol: string;
  hostname: string;
  isSecureContext: boolean;
}

/**
 * WebCodecs and WebRTC are only offered from trustworthy origins. Browsers
 * treat loopback HTTP as trustworthy, but check it explicitly so localhost
 * development keeps working in environments that report isSecureContext late.
 */
export function supportsSecureStreamModes(environment: StreamEnvironment): boolean {
  if (environment.isSecureContext || environment.protocol === 'https:') return true;

  const hostname = environment.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
}

/** Fall back to the universally available MJPEG pipeline on insecure LAN URLs. */
export function initialStreamMode(secureModesAvailable: boolean): DeviceStreamMode {
  return secureModesAvailable ? DEFAULT_STREAM_MODE : 'mjpeg';
}
