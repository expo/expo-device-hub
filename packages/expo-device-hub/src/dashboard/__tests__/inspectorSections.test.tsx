import { expect, test } from 'bun:test';
import { type DeviceClient, type DevicePlatform } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { LogSidebar } from '../../../../@expo/hub-components/src/dashboard/LogSidebar';

function inspectorClient(platform: DevicePlatform): DeviceClient {
  const ios = platform === 'ios';
  return {
    platform,
    status: 'streaming',
    error: null,
    screen: { width: 390, height: 844 },
    fps: 60,
    devices: [],
    logs: [],
    logsEnabled: false,
    attachLogs: () => {},
    detachLogs: () => {},
    clearLogs: () => {},
    events: [],
    eventsEnabled: false,
    attachEvents: () => {},
    detachEvents: () => {},
    clearEvents: () => {},
    activity: ios
      ? { hostCores: 8, samples: [], errored: false, stale: false }
      : null,
    deviceSettings: ios
      ? {
          appearance: 'light',
          'liquid-glass': 'clear',
          'color-filter': 'none',
          'text-size': 'large',
          'reduce-motion': 'off',
          'increase-contrast': 'off',
          'show-borders': 'off',
          'reduce-transparency': 'off',
          voiceover: 'off',
        }
      : { appearance: 'light' },
    deviceSettingsPending: null,
    setDeviceSetting: () => {},
    streamSettings: ios
      ? {
          mjpegFps: 60,
          mjpegQuality: 0.7,
          maxDimension: 0,
          h264Bitrate: 6_000_000,
          h264Fps: 60,
        }
      : null,
    streamSettingsPending: false,
    updateStreamSettings: () => {},
    webRtcCodec: 'h264',
    setWebRtcCodec: () => {},
    capabilities: {
      deviceSettings: true,
      activity: ios,
      events: true,
      streamSettings: ios,
    },
    foregroundApp: null,
    videoKind: 'img',
    attachVideo: () => {},
    sendTouch: () => {},
    sendKey: () => false,
    pressButton: () => {},
    reload: () => {},
    rotate: () => {},
    screenshot: async () => null,
    appearance: 'light',
    setAppearance: () => {},
    hardwareKeyboardConnected: ios,
    setHardwareKeyboardConnected: () => {},
    toggleSoftwareKeyboard: () => {},
  };
}

test('renders every supported iOS inspector section and option', () => {
  const html = renderToStaticMarkup(
    <LogSidebar
      client={inspectorClient('ios')}
      streamMode="h264"
      httpCodec="h264"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
      onHttpCodecChange={() => {}}
    />,
  );

  for (const label of ['Device options', 'Activity', 'Events', 'Stream options', 'Logs']) {
    expect(html).toContain(`aria-label="${label}"`);
  }
  for (const label of [
    'Appearance',
    'Liquid glass',
    'Color filter',
    'Text size',
    'Reduce motion',
    'Increase contrast',
    'Show borders',
    'Reduce transparency',
    'VoiceOver',
  ]) {
    expect(html).toContain(label);
  }
  expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
  expect(html.match(/aria-expanded="false"/g)?.length).toBe(4);
});

test('omits unsupported Android activity, stream, and iOS-only options', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);

  for (const label of ['Device options', 'Events', 'Logs', 'Appearance']) {
    expect(html).toContain(label);
  }
  for (const label of ['Activity', 'Stream options', 'Liquid glass', 'VoiceOver']) {
    expect(html).not.toContain(`>${label}<`);
  }
  expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
  expect(html.match(/aria-expanded="false"/g)?.length).toBe(2);
});
