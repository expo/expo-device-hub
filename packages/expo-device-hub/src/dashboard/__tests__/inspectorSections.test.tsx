import { expect, test } from 'bun:test';
import { type DeviceClient, type DevicePlatform } from '@expo/hub-client';
import { type Device, NO_DEVICE_FRAME_DESCRIPTION } from '@expo/hub-components';
import { renderToStaticMarkup } from 'react-dom/server';

import { LogSidebar } from '../../../../@expo/hub-components/src/dashboard/LogSidebar';
import {
  StreamOptionsSection,
} from '../../../../@expo/hub-components/src/dashboard/StreamOptionsSection';
import { StreamStatistics } from '../../../../@expo/hub-components/src/dashboard/StreamStatistics';

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
    streamStats: null,
    setStreamStatsEnabled: () => {},
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

type WebRtcStreamStats = NonNullable<DeviceClient['streamStats']>;
type WebRtcStreamStatsSample = WebRtcStreamStats['samples'][number];

function streamSample(
  overrides: Partial<WebRtcStreamStatsSample> = {},
): WebRtcStreamStatsSample {
  return {
    atMs: 1_000,
    serverFps: null,
    clientFps: null,
    clientBitrateBps: null,
    clientPacketLossRatio: null,
    clientJitterMs: null,
    clientJitterBufferMs: null,
    clientDroppedFrames: null,
    clientFreezeCount: null,
    clientFreezeDurationMs: null,
    clientRoundTripMs: null,
    clientIcePath: 'unknown',
    ...overrides,
  };
}

function streamStats(
  samples: readonly WebRtcStreamStatsSample[],
  overrides: Partial<Omit<WebRtcStreamStats, 'samples'>> = {},
): WebRtcStreamStats {
  return {
    samples,
    stale: false,
    serverStale: false,
    encoder: null,
    capture: null,
    ...overrides,
  };
}

const encoderStats = {
  codec: 'video/H264',
  encodeFps: 29.8,
  targetBitrateBps: 5_750_000,
  encodeMsPerFrame: 2.4,
  framesEncoded: 1_200,
  framesSent: 1_190,
  framesDropped: 10,
  packetLossRatio: 0.012,
  qualityLimitationReason: 'bandwidth',
  publisherFps: null,
  publisherSubmittedFrames: null,
  publisherDroppedFrames: null,
  payloadBitrateBps: null,
} satisfies NonNullable<WebRtcStreamStats['encoder']>;

const captureStats = {
  screenFrames: 1_621_585,
  idleFrames: 0,
  offeredFrames: 105_469,
  forwardedFrames: 4_414,
  pumpRestarts: 2,
} satisfies NonNullable<WebRtcStreamStats['capture']>;

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

function streamStatisticGroupMarkup(html: string, label: string) {
  const marker = `<div role="rowgroup" aria-label="${label}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = html.indexOf('<div role="rowgroup"', start + marker.length);
  return html.slice(start, next === -1 ? html.length : next);
}

function streamStatisticValue(group: string, label: string) {
  const rowIndex = group.indexOf(`data-stream-statistic="${label}"`);
  expect(rowIndex).toBeGreaterThanOrEqual(0);

  const cellStart = group.indexOf('<span role="cell"', rowIndex);
  const valueStart = group.indexOf('>', cellStart) + 1;
  const valueEnd = group.indexOf('</span>', valueStart);
  return group.slice(valueStart, valueEnd).replace(/<[^>]+>/g, '').trim();
}

function openingTag(html: string, marker: string) {
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  return html.slice(start, html.indexOf('>', start) + 1);
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

test('renders grouped WebRTC statistics with rich client, encoder, and capture values', () => {
  const client = {
    ...inspectorClient('ios'),
    streamStats: streamStats(
      [
        streamSample(),
        streamSample({
          atMs: 2_000,
          serverFps: 30,
          clientFps: 29,
          clientBitrateBps: 5_750_000,
          clientPacketLossRatio: 0.012,
          clientJitterMs: 8.44,
          clientJitterBufferMs: 39.6,
          clientDroppedFrames: 3,
          clientFreezeCount: 2,
          clientFreezeDurationMs: 1_500,
          clientRoundTripMs: 30.6,
          clientIcePath: 'relay',
        }),
      ],
      { encoder: encoderStats, capture: captureStats },
    ),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );

  expect(html).toContain(
    '<div role="table" aria-label="WebRTC stream statistics" aria-colcount="2"',
  );
  expect(
    openingTag(
      html,
      '<div role="table" aria-label="WebRTC stream statistics" aria-colcount="2"',
    ),
  ).toContain('overflow:visible');
  expect(
    html.match(/grid-template-columns:repeat\(auto-fit, minmax\(150px, 1fr\)\)/g),
  ).toHaveLength(5);
  const stream = streamStatisticGroupMarkup(html, 'Stream statistics');
  const receiver = streamStatisticGroupMarkup(html, 'Client statistics');
  const encoder = streamStatisticGroupMarkup(html, 'Encoder statistics');
  const capture = streamStatisticGroupMarkup(html, 'Capture statistics');

  expect(streamStatisticValue(stream, 'Server FPS')).toBe('30 FPS');
  expect(streamStatisticValue(stream, 'Client FPS')).toBe('29 FPS');
  expect(streamStatisticValue(stream, 'Client bitrate')).toBe('5.75 Mbps');
  expect(streamStatisticValue(receiver, 'Packet loss')).toBe('1.2%');
  expect(streamStatisticValue(receiver, 'Jitter')).toBe('8.4 ms');
  expect(streamStatisticValue(receiver, 'Jitter buffer')).toBe('40 ms');
  expect(streamStatisticValue(receiver, 'Dropped frames')).toBe('3');
  expect(streamStatisticValue(receiver, 'Freezes')).toBe('2 · 1.5 s');
  expect(streamStatisticValue(receiver, 'RTT')).toBe('31 ms');
  expect(streamStatisticValue(receiver, 'ICE path')).toBe('Via relay');
  expect(streamStatisticValue(encoder, 'Codec')).toBe('H.264');
  expect(streamStatisticValue(encoder, 'Encode FPS')).toBe('30 FPS');
  expect(streamStatisticValue(encoder, 'Target bitrate')).toBe('5.75 Mbps');
  expect(streamStatisticValue(encoder, 'Encode time / frame')).toBe('2.4 ms');
  expect(streamStatisticValue(encoder, 'Frames encoded')).toBe('1.2k');
  expect(streamStatisticValue(encoder, 'Frames dropped')).toBe('10');
  expect(streamStatisticValue(encoder, 'Packet loss')).toBe('1.2%');
  expect(streamStatisticValue(encoder, 'Limitation')).toBe('Network');
  expect(streamStatisticValue(capture, 'Screen frames')).toBe('1.62M');
  expect(streamStatisticValue(capture, 'Idle frames')).toBe('0');
  expect(streamStatisticValue(capture, 'Capture deliveries')).toBe('105.5k');
  expect(streamStatisticValue(capture, 'Pacer submissions')).toBe('4.4k');
  expect(streamStatisticValue(capture, 'Pump restarts')).toBe('2');
  expect(html).toContain('role="img" aria-label="Client FPS: 29 FPS"');
  expect(html).toContain('role="img" aria-label="Client bitrate: 5.75 Mbps"');
  expect(openingTag(html, '<svg role="img" aria-label="Client FPS: 29 FPS"')).toContain(
    'overflow:visible',
  );
  expect(openingTag(html, '<svg role="img" aria-label="Client bitrate: 5.75 Mbps"')).toContain(
    'overflow:visible',
  );
  expect(html.match(/>Last 60 samples</g)).toHaveLength(2);
});

test('keeps measured zero distinct from unavailable WebRTC values', () => {
  const client = {
    ...inspectorClient('ios'),
    streamStats: streamStats(
      [
        streamSample({
          serverFps: 0,
          clientFps: 0,
          clientBitrateBps: 0,
          clientPacketLossRatio: 0,
          clientDroppedFrames: 0,
          clientFreezeCount: 0,
        }),
      ],
      {
        encoder: {
          codec: null,
          encodeFps: 0,
          targetBitrateBps: null,
          encodeMsPerFrame: null,
          framesEncoded: 0,
          framesSent: 0,
          framesDropped: 0,
          packetLossRatio: 0,
          qualityLimitationReason: 'none',
          publisherFps: null,
          publisherSubmittedFrames: null,
          publisherDroppedFrames: null,
          payloadBitrateBps: null,
        },
      },
    ),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );
  const stream = streamStatisticGroupMarkup(html, 'Stream statistics');
  const receiver = streamStatisticGroupMarkup(html, 'Client statistics');
  const encoder = streamStatisticGroupMarkup(html, 'Encoder statistics');

  expect(streamStatisticValue(stream, 'Server FPS')).toBe('0.0 FPS');
  expect(streamStatisticValue(stream, 'Client bitrate')).toBe('0 kbps');
  expect(streamStatisticValue(receiver, 'Packet loss')).toBe('0.0%');
  expect(streamStatisticValue(receiver, 'Jitter')).toBe('—');
  expect(streamStatisticValue(receiver, 'Dropped frames')).toBe('0');
  expect(streamStatisticValue(receiver, 'Freezes')).toBe('0');
  expect(streamStatisticValue(receiver, 'RTT')).toBe('—');
  expect(streamStatisticValue(receiver, 'ICE path')).toBe('—');
  expect(streamStatisticValue(encoder, 'Codec')).toBe('—');
  expect(streamStatisticValue(encoder, 'Frames sent')).toBe('0');
  expect(streamStatisticValue(encoder, 'Packet loss')).toBe('0.0%');
  expect(streamStatisticValue(encoder, 'Limitation')).toBe('None');
  expect(html).not.toContain('— ms');
  expect(html).not.toContain('— FPS');
});

test('shows only the server statistics that serve-emu can provide', () => {
  const client = {
    ...inspectorClient('android'),
    streamStats: streamStats(
      [streamSample({ serverFps: 30, clientFps: 29, clientBitrateBps: 3_000_000 })],
      {
        encoder: {
          codec: 'video/H264',
          encodeFps: 30,
          targetBitrateBps: 8_000_000,
          encodeMsPerFrame: null,
          framesEncoded: 1_200,
          framesSent: null,
          framesDropped: null,
          packetLossRatio: null,
          qualityLimitationReason: null,
          publisherFps: 29.5,
          publisherSubmittedFrames: 1_190,
          publisherDroppedFrames: 10,
          payloadBitrateBps: 5_750_000,
        },
        capture: {
          screenFrames: null,
          idleFrames: null,
          offeredFrames: 1_200,
          forwardedFrames: 1_180,
          pumpRestarts: null,
        },
      },
    ),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );
  const stream = streamStatisticGroupMarkup(html, 'Stream statistics');
  const receiver = streamStatisticGroupMarkup(html, 'Client statistics');
  const encoder = streamStatisticGroupMarkup(html, 'Encoder statistics');
  const capture = streamStatisticGroupMarkup(html, 'Capture statistics');

  expect(rowOpeningTag(html, 'WebRTC codec')).toContain('border-bottom:');
  expect(openingTag(stream, '<span role="columnheader"')).not.toContain('border-top:');
  expect(openingTag(receiver, '<span role="columnheader"')).toContain('border-top:');
  expect(streamStatisticValue(stream, 'Server FPS')).toBe('30 FPS');
  expect(streamStatisticValue(encoder, 'Codec')).toBe('H.264');
  expect(encoder).not.toContain('data-stream-statistic="Output FPS"');
  expect(streamStatisticValue(encoder, 'Configured bitrate')).toBe('8.00 Mbps');
  expect(streamStatisticValue(encoder, 'Output frames')).toBe('1.2k');
  expect(streamStatisticValue(encoder, 'Publisher FPS')).toBe('30 FPS');
  expect(streamStatisticValue(encoder, 'Payload bitrate')).toBe('5.75 Mbps');
  expect(streamStatisticValue(encoder, 'Publisher submissions')).toBe('1.2k');
  expect(streamStatisticValue(encoder, 'Publisher drops')).toBe('10');
  expect(streamStatisticValue(capture, 'Publisher offers')).toBe('1.2k');
  expect(streamStatisticValue(capture, 'Publisher forwards')).toBe('1.2k');
  expect(encoder.match(/data-stream-statistic=/g)).toHaveLength(7);
  expect(capture.match(/data-stream-statistic=/g)).toHaveLength(2);
  for (const label of [
    'Encode FPS',
    'Target bitrate',
    'Encode time / frame',
    'Frames encoded',
    'Frames sent',
    'Frames dropped',
    'Packet loss',
    'Limitation',
    'Screen frames',
    'Idle frames',
    'Capture deliveries',
    'Pacer submissions',
    'Pump restarts',
  ]) {
    expect(`${encoder}${capture}`).not.toContain(`data-stream-statistic="${label}"`);
  }
  expect(`${encoder}${capture}`).not.toContain('>—</span>');
});

test('shows the WebRTC measuring state without inventing zero readings', () => {
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={inspectorClient('android')}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );

  expect(html).toContain('role="status"');
  expect(html).toContain('Measuring WebRTC stream…');
  expect(html).toContain('aria-label="WebRTC stream statistics"');
  expect(html.match(/>—<\/span>/g)).toHaveLength(10);
  expect(html).not.toContain('role="img"');
});

test('keeps measuring when the first WebRTC counter sample has no rate window yet', () => {
  const client = {
    ...inspectorClient('android'),
    streamStats: streamStats([streamSample()]),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );

  expect(html).toContain('Measuring WebRTC stream…');
  expect(html.match(/>—<\/span>/g)).toHaveLength(10);
  expect(html).not.toContain('role="img"');
});

test('omits unsupported server groups while retaining client statistics', () => {
  const client = {
    ...inspectorClient('android'),
    streamStats: streamStats([
      streamSample({ clientFps: 30, clientBitrateBps: 3_000_000 }),
    ]),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="webrtc"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );

  expect(html).toContain('aria-label="Client statistics"');
  expect(html).not.toContain('aria-label="Encoder statistics"');
  expect(html).not.toContain('aria-label="Capture statistics"');
});

test('distinguishes paused server statistics from paused client statistics', () => {
  const sample = streamSample({ serverFps: 30, clientFps: 29, clientBitrateBps: 3_000_000 });
  const renderStats = (stats: WebRtcStreamStats) =>
    renderToStaticMarkup(<StreamStatistics stats={stats} platform="android" />);

  const serverHtml = renderStats(
    streamStats([sample], { encoder: encoderStats, serverStale: true }),
  );
  expect(serverHtml).toContain('Server stream statistics are paused');
  expect(streamStatisticGroupMarkup(serverHtml, 'Stream statistics')).toContain(
    'data-server-stale="true"',
  );
  expect(streamStatisticGroupMarkup(serverHtml, 'Encoder statistics')).toContain(
    'data-stale="true"',
  );
  expect(
    streamStatisticValue(
      streamStatisticGroupMarkup(serverHtml, 'Stream statistics'),
      'Server FPS',
    ),
  ).toBe('30 FPS');
  expect(serverHtml).toContain('role="img" aria-label="Client FPS: 29 FPS"');

  const clientHtml = renderStats(streamStats([sample], { stale: true }));
  expect(clientHtml).toContain('Client stream statistics are paused');
  expect(streamStatisticGroupMarkup(clientHtml, 'Client statistics')).toContain(
    'data-stale="true"',
  );
  expect(clientHtml).not.toContain('Server stream statistics are paused');
});

test('hides WebRTC statistics when another transport is active', () => {
  const client = {
    ...inspectorClient('android'),
    streamStats: streamStats([
      streamSample({
        atMs: 2_000,
        serverFps: 30,
        clientFps: 29,
        clientBitrateBps: 5_750_000,
      }),
    ]),
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(
    <StreamOptionsSection
      client={client}
      defaultOpen
      streamMode="h264"
      streamModeAvailability={{ mjpeg: true, h264: true, webrtc: true }}
      onStreamModeChange={() => {}}
    />,
  );

  expect(html).not.toContain('aria-label="WebRTC stream statistics"');
  expect(html).not.toContain('role="img"');
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
