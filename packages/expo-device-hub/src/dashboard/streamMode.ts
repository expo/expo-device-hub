import { type DeviceStreamMode } from '@expo/hub-client';
import { type StreamModeAvailability } from '@expo/hub-components';

export interface StreamBrowserFeatures {
  secureContext: boolean;
  h264Decoder: boolean;
  webRtc: boolean;
}

/** Derive selectable transports without granting secure-only APIs on LAN HTTP. */
export function streamModeAvailability(
  features: StreamBrowserFeatures,
): StreamModeAvailability {
  return {
    mjpeg: true,
    h264: features.secureContext && features.h264Decoder,
    webrtc: features.secureContext && features.webRtc,
  };
}

export function browserStreamModeAvailability(): StreamModeAvailability {
  if (typeof window === 'undefined') {
    return { mjpeg: true, h264: false, webrtc: false };
  }
  return streamModeAvailability({
    secureContext: window.isSecureContext,
    h264Decoder: typeof window.VideoDecoder !== 'undefined',
    webRtc:
      typeof window.RTCPeerConnection !== 'undefined' &&
      typeof window.RTCRtpReceiver !== 'undefined',
  });
}

/** Keep the requested mode when available, otherwise use the universal MJPEG path. */
export function resolveStreamMode(
  requested: DeviceStreamMode,
  availability: StreamModeAvailability,
): DeviceStreamMode {
  return availability[requested] ? requested : 'mjpeg';
}
