import { expect, test } from 'bun:test';
import { type DeviceClient, type DevicePlatform } from '@expo/hub-client';
import { type Device, NO_DEVICE_FRAME_DESCRIPTION } from '@expo/hub-components';
import { renderToStaticMarkup } from 'react-dom/server';

import { LogSidebar } from '../../../../@expo/hub-components/src/dashboard/LogSidebar';
import {
  StreamOptionsSection,
} from '../../../../@expo/hub-components/src/dashboard/StreamOptionsSection';

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
      : { appearance: 'light', network: 'on', 'text-size': 'medium' },
    deviceSettingsPending: new Set(),
    setDeviceSetting: () => {},
    streamCapabilities: ios
      ? {
          modeAvailability: { mjpeg: true, h264: true, webrtc: true },
          httpCodecs: ['auto', 'h264', 'mjpeg'],
          webRtcCodecs: ['h264', 'vp9', 'vp8'],
        }
      : {
          modeAvailability: { mjpeg: false, h264: true, webrtc: true },
          httpCodecs: ['h264'],
          webRtcCodecs: ['h264'],
        },
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

function device(platform: DevicePlatform, deviceFrame: Device['deviceFrame']): Device {
  return {
    id: `${platform}-device`,
    name:
      deviceFrame === 'ios:iphone-17-pro'
        ? 'iPhone 17 Pro'
        : deviceFrame === 'android:pixel-10-pro'
          ? 'Pixel 10 Pro'
          : 'Other',
    version: platform === 'ios' ? 'iOS 27.0' : 'Android 17.0',
    platform,
    booted: true,
    physical: false,
    supported: deviceFrame !== null,
    deviceFrame,
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
  expect(html).not.toContain('>Network<');
  expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
  expect(html.match(/aria-expanded="false"/g)?.length).toBe(4);
});

test('renders Android stream options while omitting unsupported and iOS-only sections', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);

  for (const label of [
    'Device options',
    'Events',
    'Stream options',
    'Logs',
    'Appearance',
    'Network',
    'Text size',
  ]) {
    expect(html).toContain(label);
  }
  for (const label of ['Activity', 'Liquid glass', 'VoiceOver']) {
    expect(html).not.toContain(`>${label}<`);
  }
  expect(html.match(/aria-expanded="true"/g)?.length).toBe(1);
  expect(html.match(/aria-expanded="false"/g)?.length).toBe(3);
});

test('limits Android stream controls to the transports and H.264 codecs serve-emu supports', () => {
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={inspectorClient('android')}
      defaultOpen
      streamMode="webrtc"
      httpCodec="h264"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
      onHttpCodecChange={() => {}}
    />,
  );

  expect(segmentedControlMarkup(html, 'Stream transport')).toContain('>WebSocket</button>');
  expect(segmentedControlMarkup(html, 'Stream transport')).toContain('>WebRTC</button>');
  expect(segmentedControlMarkup(html, 'WebSocket codec')).toContain('>H.264</button>');
  expect(segmentedControlMarkup(html, 'WebRTC codec')).toContain('>H.264</button>');
  expect(html).not.toContain('>HTTP</button>');
  expect(html).not.toContain('>MJPEG</button>');
  expect(html).not.toContain('>VP8</button>');
  expect(html).not.toContain('>VP9</button>');
  expect(html).not.toContain('>Max size</span>');
});

test('explains when the Android host was not launched with WebRTC', () => {
  const client = {
    ...inspectorClient('android'),
    streamCapabilities: {
      modeAvailability: { mjpeg: false, h264: true, webrtc: false },
      httpCodecs: ['h264'],
      webRtcCodecs: ['h264'],
    },
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="h264"
      httpCodec="h264"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
      onHttpCodecChange={() => {}}
    />,
  );

  expect(segmentedControlMarkup(html, 'Stream transport')).toContain('disabled=""');
  expect(html).toContain('Start the standalone server with --transport webrtc');
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

test('maps Android device options onto Network and S–XL controls', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);
  const network = segmentedControlMarkup(html, 'Network');
  const textSize = segmentedControlMarkup(html, 'Text size');

  expect(network).toContain('>On</button>');
  expect(network).toContain('>Off</button>');
  expect(network).toMatch(/<button[^>]*aria-pressed="true"[^>]*>On<\/button>/);
  expect(textSize).toContain('>S</button>');
  expect(textSize).toContain('>M</button>');
  expect(textSize).toContain('>L</button>');
  expect(textSize).toContain('>XL</button>');
  expect(textSize).not.toContain('>XS</button>');
  expect(textSize).not.toContain('>2XL</button>');
  expect(textSize.match(/padding:0 8px/g)).toHaveLength(4);
  expect(textSize).toMatch(/<button[^>]*aria-pressed="true"[^>]*>M<\/button>/);
});

test('keeps keyboard controls in the device options list and omits only its final divider', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);

  expect(rowOpeningTag(html, 'VoiceOver')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Hardware keyboard')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Software keyboard')).not.toContain('border-bottom:');
});

test('omits the final device option divider when no keyboard controls follow', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);

  expect(rowOpeningTag(html, 'Appearance')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Network')).toContain('border-bottom:');
  expect(rowOpeningTag(html, 'Text size')).not.toContain('border-bottom:');
});

test('disables only the pending Android device setting', () => {
  const client = {
    ...inspectorClient('android'),
    deviceSettingsPending: new Set(['network'] as const),
  };
  const html = renderToStaticMarkup(<LogSidebar client={client} />);

  expect(segmentedControlMarkup(html, 'Network').match(/disabled=""/g)).toHaveLength(2);
  expect(segmentedControlMarkup(html, 'Appearance')).not.toContain('disabled=""');
  expect(segmentedControlMarkup(html, 'Text size')).not.toContain('disabled=""');
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

test('shows an enabled viewer-local frame switch for exact device profiles', () => {
  for (const [platform, frame] of [
    ['ios', 'ios:iphone-17-pro'],
    ['android', 'android:pixel-10-pro'],
  ] as const) {
    const onMarkup = renderToStaticMarkup(
      <LogSidebar
        client={inspectorClient(platform)}
        device={device(platform, frame)}
        showDeviceFrame
        onShowDeviceFrameChange={() => {}}
      />,
    );
    const offMarkup = renderToStaticMarkup(
      <LogSidebar
        client={inspectorClient(platform)}
        device={device(platform, frame)}
        showDeviceFrame={false}
        onShowDeviceFrameChange={() => {}}
      />,
    );

    expect(switchMarkup(onMarkup, 'Show device frame')).toContain('aria-checked="true"');
    expect(switchMarkup(onMarkup, 'Show device frame')).not.toContain('disabled=""');
    expect(switchMarkup(offMarkup, 'Show device frame')).toContain('aria-checked="false"');
    expect(switchMarkup(offMarkup, 'Show device frame')).not.toContain('disabled=""');
  }
});

test('places the device frame option immediately above the hardware keyboard', () => {
  const html = renderToStaticMarkup(
    <LogSidebar
      client={inspectorClient('ios')}
      device={device('ios', 'ios:iphone-17-pro')}
      showDeviceFrame
      onShowDeviceFrameChange={() => {}}
    />,
  );

  const frameIndex = html.indexOf('>Show device frame</span>');
  const hardwareKeyboardIndex = html.indexOf('>Hardware keyboard</span>');

  expect(frameIndex).toBeGreaterThan(html.indexOf('>VoiceOver</span>'));
  expect(frameIndex).toBeLessThan(hardwareKeyboardIndex);
});

test('keeps the frame option disabled with an explanation for unsupported devices', () => {
  for (const platform of ['ios', 'android'] as const) {
    const client = {
      ...inspectorClient(platform),
      capabilities: {
        deviceSettings: false,
        activity: false,
        events: true,
        streamSettings: false,
      },
    };
    const html = renderToStaticMarkup(
      <LogSidebar
        client={client}
        device={device(platform, null)}
        showDeviceFrame
        onShowDeviceFrameChange={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Device options"');
    expect(switchMarkup(html, 'Show device frame')).toContain('aria-checked="false"');
    expect(switchMarkup(html, 'Show device frame')).toContain('disabled=""');
    expect(html).toContain(NO_DEVICE_FRAME_DESCRIPTION);
    expect(html).not.toContain('>Appearance</span>');
  }
});

test('shows only the viewer-local frame option while iOS device settings are unavailable', () => {
  const client = {
    ...inspectorClient('ios'),
    capabilities: {
      deviceSettings: false,
      activity: false,
      events: true,
      streamSettings: false,
    },
    deviceSettings: null,
  };
  const html = renderToStaticMarkup(
    <LogSidebar
      client={client}
      device={device('ios', 'ios:iphone-17-pro')}
      showDeviceFrame
      onShowDeviceFrameChange={() => {}}
    />,
  );

  expect(switchMarkup(html, 'Show device frame')).not.toContain('disabled=""');
  expect(html).not.toContain('>Appearance</span>');
  expect(html).not.toContain('>Liquid glass</span>');
  expect(html).not.toContain('>Keyboard</span>');
});
