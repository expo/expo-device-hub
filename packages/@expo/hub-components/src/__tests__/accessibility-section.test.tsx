import { describe, expect, test } from 'bun:test';
import { type AccessibilityNode, type DeviceClient } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccessibilitySection } from '../dashboard/AccessibilitySection';

const BASE_CLIENT: DeviceClient = {
  platform: 'ios',
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
  activity: null,
  deviceSettings: null,
  deviceSettingsPending: new Set(),
  setDeviceSetting: () => {},
  displayWidthDp: null,
  camera: null,
  cameraPending: new Set(),
  cameraError: null,
  setCameraImage: () => {},
  clearCameraImage: () => {},
  accessibility: null,
  accessibilityPending: false,
  accessibilityError: null,
  refreshAccessibility: () => {},
  streamCapabilities: null,
  streamSettings: null,
  streamSettingsPending: false,
  updateStreamSettings: () => {},
  streamSource: null,
  streamSourcePending: false,
  streamSourceError: null,
  setStreamSource: () => {},
  setGrpcImageMode: () => {},
  setGrpcEncoder: () => {},
  setGrpcInputSource: () => {},
  streamStats: null,
  setStreamStatsEnabled: () => {},
  webRtcCodec: 'h264',
  setWebRtcCodec: () => {},
  capabilities: {
    deviceSettings: false,
    activity: false,
    events: false,
    camera: false,
    accessibility: true,
    streamSettings: false,
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
  hardwareKeyboardConnected: null,
  setHardwareKeyboardConnected: () => {},
  toggleSoftwareKeyboard: () => {},
};

const CAPTURED_AT = Date.parse('2026-09-09T10:00:00.000Z');

function node(overrides: Partial<AccessibilityNode> = {}): AccessibilityNode {
  return {
    id: 'n1',
    label: 'Sign in',
    role: 'button',
    enabled: true,
    clickable: true,
    frame: { x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
    ...overrides,
  };
}

function render(overrides: Partial<DeviceClient>) {
  return renderToStaticMarkup(
    <AccessibilitySection client={{ ...BASE_CLIENT, ...overrides }} defaultOpen />,
  );
}

function refreshTag(html: string) {
  const index = html.indexOf('>Refresh</button>');
  expect(index).toBeGreaterThanOrEqual(0);

  return html.slice(html.lastIndexOf('<button', index), index + 1);
}

function rowTag(html: string, ariaLabel: string) {
  const index = html.indexOf(`aria-label="${ariaLabel}"`);
  expect(index).toBeGreaterThanOrEqual(0);

  const start = html.lastIndexOf('<button', index);
  return html.slice(start, html.indexOf('>', index) + 1);
}

describe('AccessibilitySection', () => {
  test('announces a read in flight and disables Refresh', () => {
    const html = render({ accessibilityPending: true });
    expect(html).toContain('role="status"');
    expect(html).toContain('Reading the screen…');
    expect(refreshTag(html)).toContain('disabled=""');
  });

  test('reports a failed read while keeping the last snapshot on screen', () => {
    const html = render({
      accessibilityError: 'Accessibility unavailable on this simulator.',
      accessibility: { capturedAt: CAPTURED_AT, nodes: [node()] },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Accessibility unavailable on this simulator.');
    expect(html).toContain('>Sign in<');
  });

  test('reports an empty screen', () => {
    const html = render({ accessibility: { capturedAt: CAPTURED_AT, nodes: [] } });
    expect(html).toContain('No accessible elements on this screen.');
  });

  test('lists each element with its role and a capture time', () => {
    const html = render({
      accessibility: {
        capturedAt: CAPTURED_AT,
        nodes: [node(), node({ id: 'n2', label: 'Heading', role: 'StaticText', clickable: false })],
      },
    });
    expect(html).toContain(`Captured ${new Date(CAPTURED_AT).toLocaleTimeString()}`);
    expect(html).toContain('>Sign in<');
    expect(html).toContain('>button · tappable<');
    expect(html).toContain('>Heading<');
    expect(html).toContain('>StaticText<');
    expect(rowTag(html, 'Tap Sign in')).not.toContain('disabled');
  });

  test('dims a disabled element and refuses its tap', () => {
    const html = render({
      accessibility: { capturedAt: CAPTURED_AT, nodes: [node({ label: 'Dimmed', enabled: false })] },
    });
    const tag = rowTag(html, 'Tap Dimmed');
    expect(tag).toContain('disabled=""');
    expect(tag).toContain('opacity:0.5');
  });
});
