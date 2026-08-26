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
    deviceSettingsPending: new Set(),
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

function rowOpeningTag(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</span>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const rowStart = html.lastIndexOf('<div style="', labelIndex);
  const rowEnd = html.indexOf('>', rowStart);
  return html.slice(rowStart, rowEnd + 1);
}

function segmentedControlMarkup(html: string, label: string) {
  const controlStart = html.indexOf(`<div role="group" aria-label="${label}"`);
  expect(controlStart).toBeGreaterThanOrEqual(0);

  const controlEnd = html.indexOf('</div>', controlStart);
  return html.slice(controlStart, controlEnd + '</div>'.length);
}

function switchMarkup(html: string, label: string) {
  const labelIndex = html.indexOf(`aria-label="${label}"`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const switchStart = html.lastIndexOf('<button', labelIndex);
  const switchEnd = html.indexOf('</button>', labelIndex);
  return html.slice(switchStart, switchEnd + '</button>'.length);
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

test('uses the shared stream-pill spacing for every device option', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);

  for (const [label, optionCount] of [
    ['Appearance', 2],
    ['Liquid glass', 2],
    ['Color filter', 5],
    ['Text size', 7],
  ] as const) {
    const control = segmentedControlMarkup(html, label);

    expect(rowOpeningTag(html, label)).toContain('flex-wrap:wrap');
    expect(rowOpeningTag(html, label)).toContain('min-height:51px');
    expect(rowOpeningTag(html, label)).toContain('gap:12px');
    expect(control.match(/padding:0 8px/g)).toHaveLength(optionCount);
    expect(control.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(control.match(/aria-pressed="false"/g)).toHaveLength(optionCount - 1);
    expect(html).toMatch(
      new RegExp(
        `<span style="[^"]*">${label}</span><div role="group" aria-label="${label}"`,
      ),
    );
  }
});

test('keeps keyboard controls in the device options list and omits only its final divider', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);

  expect(rowOpeningTag(html, 'VoiceOver')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Hardware keyboard')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Software keyboard')).not.toContain('border-bottom:');
});

test('omits the final device option divider when no keyboard controls follow', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);

  expect(rowOpeningTag(html, 'Appearance')).not.toContain('border-bottom:');
});

test('disables only the device setting with an in-flight update', () => {
  const client = {
    ...inspectorClient('ios'),
    deviceSettingsPending: new Set(['appearance'] as const),
  };
  const html = renderToStaticMarkup(<LogSidebar client={client} />);

  expect(segmentedControlMarkup(html, 'Appearance').match(/disabled=""/g)).toHaveLength(2);
  expect(segmentedControlMarkup(html, 'Liquid glass')).not.toContain('disabled=""');
  expect(switchMarkup(html, 'Reduce motion')).not.toContain('disabled=""');
});
