import { expect, test } from 'bun:test';
import { type DeviceClient } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  StreamOptionsSectionContent,
  type StreamOptionsSectionProps,
} from '../dashboard/StreamOptionsSection';

const client: DeviceClient = {
  platform: 'ios',
  status: 'streaming',
  error: null,
  screen: { width: 390, height: 844 },
  fps: 60,
  activeStreamMode: 'mjpeg',
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
  activity: null,
  deviceSettings: null,
  deviceSettingsError: null,
  deviceSettingsPending: new Set(),
  retryDeviceSettings: () => {},
  setDeviceSetting: () => {},
  streamSettings: {
    mjpegFps: 60,
    mjpegQuality: 0.7,
    maxDimension: 0,
    h264Bitrate: 6_000_000,
    h264Fps: 60,
  },
  streamSettingsPending: false,
  updateStreamSettings: () => {},
  webRtcCodec: 'h264',
  setWebRtcCodec: () => {},
  capabilities: {
    deviceSettings: true,
    activity: true,
    events: true,
    streamSettings: true,
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
  hardwareKeyboardConnected: true,
  setHardwareKeyboardConnected: () => {},
  toggleSoftwareKeyboard: () => {},
};

function renderStreamOptions(props: StreamOptionsSectionProps) {
  return renderToStaticMarkup(<StreamOptionsSectionContent {...props} />);
}

function segmentedControlMarkup(html: string, label: string) {
  const controlStart = html.indexOf(`<div role="group" aria-label="${label}"`);
  expect(controlStart).toBeGreaterThanOrEqual(0);

  const controlEnd = html.indexOf('</div>', controlStart);
  return html.slice(controlStart, controlEnd + '</div>'.length);
}

function optionMarkup(control: string, label: string) {
  const labelIndex = control.indexOf(`>${label}</button>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const optionStart = control.lastIndexOf('<button', labelIndex);
  const optionEnd = control.indexOf('>', optionStart);
  return control.slice(optionStart, optionEnd + 1);
}

test('shows MJPEG and disables every HTTP codec option when H.264 is unavailable', () => {
  const html = renderStreamOptions({
    client,
    streamMode: 'mjpeg',
    httpCodec: 'auto',
    streamModeAvailability: { mjpeg: true, h264: false, webrtc: false },
    onStreamModeChange: () => {},
    onHttpCodecChange: () => {},
  });
  const control = segmentedControlMarkup(html, 'HTTP codec');

  expect(optionMarkup(control, 'Auto')).toContain('aria-pressed="false"');
  expect(optionMarkup(control, 'MJPEG')).toContain('aria-pressed="true"');
  expect(control.match(/disabled=""/g)).toHaveLength(3);
});

test('keeps the selected HTTP codec interactive when H.264 is available', () => {
  const html = renderStreamOptions({
    client,
    streamMode: 'h264',
    httpCodec: 'auto',
    streamModeAvailability: { mjpeg: true, h264: true, webrtc: true },
    onStreamModeChange: () => {},
    onHttpCodecChange: () => {},
  });
  const control = segmentedControlMarkup(html, 'HTTP codec');

  expect(optionMarkup(control, 'Auto')).toContain('aria-pressed="true"');
  expect(optionMarkup(control, 'MJPEG')).toContain('aria-pressed="false"');
  expect(control).not.toContain('disabled=""');
});
