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
    streamSettings: {
      mjpegFps: 60,
      mjpegQuality: 0.7,
      maxDimension: 0,
      h264Bitrate: 6_000_000,
      h264Fps: 60,
    },
    streamSettingsPending: false,
    updateStreamSettings: () => {},
    streamSource: ios
      ? null
      : {
          mode: 'scrcpy',
          grpcImageMode: 'png',
          inputSource: 'scrcpy',
          availableInputSources: ['scrcpy'],
          availableModes: ['scrcpy', 'grpc-screenshot'],
          sessionGeneration: 0,
        },
    streamSourcePending: false,
    streamSourceError: null,
    setStreamSource: () => {},
    setGrpcImageMode: () => {},
    setGrpcInputSource: () => {},
    streamStats: null,
    setStreamStatsEnabled: () => {},
    webRtcCodec: 'h264',
    setWebRtcCodec: () => {},
    capabilities: {
      deviceSettings: true,
      activity: ios,
      events: true,
      streamSettings: ios
        ? {
            mjpegFps: true,
            mjpegQuality: true,
            maxDimension: true,
            h264Bitrate: true,
            h264Fps: true,
          }
        : { maxDimension: true },
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
  grpc: null,
} satisfies NonNullable<WebRtcStreamStats['capture']>;

function rowOpeningTag(html: string, label: string) {
  const labelIndex = html.indexOf(`>${label}</span>`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const rowStart = html.lastIndexOf('<div style="', labelIndex);
  const rowEnd = html.indexOf('>', rowStart);
  return html.slice(rowStart, rowEnd + 1);
}

function sectionMarkup(html: string, title: string) {
  const start = html.indexOf(`<section aria-label="${title}"`);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = html.indexOf('<section ', start + 1);
  return html.slice(start, next === -1 ? html.length : next);
}

function sectionExpanded(html: string, title: string) {
  const section = sectionMarkup(html, title);
  return section.slice(0, section.indexOf('</button>')).includes('aria-expanded="true"');
}

function switchMarkup(html: string, label: string) {
  const labelIndex = html.indexOf(`aria-label="${label}"`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const switchStart = html.lastIndexOf('<button', labelIndex);
  const switchEnd = html.indexOf('</button>', labelIndex);
  return html.slice(switchStart, switchEnd + '</button>'.length);
}

function selectMarkup(html: string, label: string) {
  const labelIndex = html.indexOf(`aria-label="${label}"`);
  expect(labelIndex).toBeGreaterThanOrEqual(0);

  const selectStart = html.lastIndexOf('<button', labelIndex);
  const selectEnd = html.indexOf('</button>', labelIndex);
  const markup = html.slice(selectStart, selectEnd + '</button>'.length);
  expect(markup).toContain('role="combobox"');
  return markup;
}

/** The label the select pill currently shows. */
function selectValue(html: string, label: string) {
  const markup = selectMarkup(html, label);
  const marker = '<span style="pointer-events:none">';
  const valueStart = markup.indexOf(marker);
  expect(valueStart).toBeGreaterThanOrEqual(0);

  return markup.slice(valueStart + marker.length, markup.indexOf('</span>', valueStart));
}

/** Every option label the select pill is sized by, in menu order. */
function selectOptionLabels(html: string, label: string) {
  return [...selectMarkup(html, label).matchAll(/<span style="grid-area:1 \/ 1">([^<]*)<\/span>/g)].map(
    (match) => match[1],
  );
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
  expect(sectionExpanded(html, 'Device options')).toBe(true);
  for (const label of ['Activity', 'Events', 'Stream options', 'Logs']) {
    expect(sectionExpanded(html, label)).toBe(false);
    expect(openingTag(html, `<section aria-label="${label}"`)).toContain('border-top:');
    expect(openingTag(html, `<section aria-label="${label}"`)).toContain('padding:0 16px;');
    expect(sectionMarkup(html, label)).toContain('grid-template-rows:0fr');
  }
  expect(openingTag(html, '<section aria-label="Device options"')).toContain('padding:0 16px;');
  expect(sectionMarkup(html, 'Device options')).toContain('grid-template-rows:1fr');
  expect(sectionMarkup(html, 'Device options')).toContain('padding-bottom:12px');
  // The title sits centered in its row, so collapsed sections line up evenly.
  expect(openingTag(html, '<button type="button" aria-expanded="true"')).toContain('padding:18px 0');
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
  expect(sectionExpanded(html, 'Device options')).toBe(true);
  for (const label of ['Events', 'Stream options', 'Logs']) {
    expect(sectionExpanded(html, label)).toBe(false);
  }
});

test('shows Android resolution while omitting encoder settings serve-emu cannot change', () => {
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

  expect(selectOptionLabels(html, 'Stream transport')).toEqual(['WebSocket', 'WebRTC']);
  expect(selectValue(html, 'Stream transport')).toBe('WebRTC');
  expect(selectOptionLabels(html, 'WebSocket codec')).toEqual(['H.264']);
  expect(selectOptionLabels(html, 'WebRTC codec')).toEqual(['H.264']);
  expect(html).not.toContain('>HTTP<');
  expect(html).not.toContain('>MJPEG<');
  expect(html).not.toContain('>VP8<');
  expect(html).not.toContain('>VP9<');
  expect(html).toContain('>Max size</span>');
  expect(selectMarkup(html, 'Max size')).not.toContain('disabled=""');
  expect(html).not.toContain('>MJPEG FPS</span>');
  expect(html).not.toContain('>MJPEG quality</span>');
  expect(html).not.toContain('>Video FPS</span>');
  expect(html).not.toContain('>Video bitrate</span>');
});

test('shows the Android emulator capture source select', () => {
  const html = renderToStaticMarkup(
    <StreamOptionsSection client={inspectorClient('android')} defaultOpen />,
  );

  expect(html).toContain('>Source</span>');
  expect(selectValue(html, 'Stream source')).toBe('scrcpy');
  expect(selectOptionLabels(html, 'Stream source')).toEqual(['scrcpy', 'gRPC']);
  expect(selectMarkup(html, 'Stream source')).not.toContain('disabled=""');
});

test('shows PNG and MMAP only while the gRPC source is active', () => {
  const scrcpyHtml = renderToStaticMarkup(
    <StreamOptionsSection client={inspectorClient('android')} defaultOpen />,
  );
  expect(scrcpyHtml).not.toContain('aria-label="gRPC image mode"');

  const grpcClient = {
    ...inspectorClient('android'),
    streamSource: {
      mode: 'grpc-screenshot',
      grpcImageMode: 'mmap',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy', 'grpc'],
      availableModes: ['scrcpy', 'grpc-screenshot'],
      sessionGeneration: 1,
    },
  } satisfies DeviceClient;
  const grpcHtml = renderToStaticMarkup(
    <StreamOptionsSection client={grpcClient} defaultOpen />,
  );

  expect(grpcHtml).toContain('>Input</span>');
  expect(selectOptionLabels(grpcHtml, 'Input source')).toEqual(['scrcpy', 'gRPC']);
  expect(selectValue(grpcHtml, 'Input source')).toBe('scrcpy');
  expect(grpcHtml).toContain('>gRPC frames</span>');
  expect(selectOptionLabels(grpcHtml, 'gRPC image mode')).toEqual(['PNG', 'MMAP']);
  expect(selectValue(grpcHtml, 'gRPC image mode')).toBe('MMAP');
});

test('disables the Android capture source select while replacement is pending', () => {
  const client = {
    ...inspectorClient('android'),
    streamSourcePending: true,
  } satisfies DeviceClient;
  const source = selectMarkup(
    renderToStaticMarkup(<StreamOptionsSection client={client} defaultOpen />),
    'Stream source',
  );

  expect(source).toContain('disabled=""');
});

test('shows an Android capture source failure below the switch', () => {
  const client = {
    ...inspectorClient('android'),
    streamSourceError: 'Unable to change stream source: Emulator gRPC endpoint is unavailable',
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(<StreamOptionsSection client={client} defaultOpen />);

  expect(html).toContain('role="alert"');
  expect(html).toContain('Unable to change stream source: Emulator gRPC endpoint is unavailable');
});

test('hides the Android capture source row when gRPC is unavailable', () => {
  const client = {
    ...inspectorClient('android'),
    streamSource: {
      mode: 'scrcpy',
      grpcImageMode: 'png',
      inputSource: 'scrcpy',
      availableInputSources: ['scrcpy'],
      availableModes: ['scrcpy'],
      sessionGeneration: 0,
    },
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(<StreamOptionsSection client={client} defaultOpen />);

  expect(html).not.toContain('aria-label="Stream source"');
});

test('disables Android resolution while a stream restart is pending', () => {
  const client = {
    ...inspectorClient('android'),
    streamSettingsPending: true,
  } satisfies DeviceClient;
  const html = renderToStaticMarkup(<StreamOptionsSection client={client} defaultOpen />);

  expect(selectMarkup(html, 'Max size')).toContain('disabled=""');
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
  expect(html.match(/title="Last 60 samples"/g)).toHaveLength(2);
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
          grpc: null,
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

test('shows the gRPC producer-to-client pipeline diagnostics', () => {
  const client = {
    ...inspectorClient('android'),
    streamStats: streamStats(
      [streamSample({ serverFps: 58, clientFps: 57.5 })],
      {
        capture: {
          screenFrames: null,
          idleFrames: null,
          offeredFrames: 580,
          forwardedFrames: 575,
          pumpRestarts: null,
          grpc: {
            imageMode: 'mmap',
            producerFps: 60,
            receiveFps: 59.5,
            usableImageFps: 59,
            encoderInputFps: 58.5,
            messagesReceived: 600,
            messagesEmitted: 590,
            messagesCoalesced: 10,
            sequenceGaps: 2,
            imagePayloadBytes: 552_960,
            transportBytes: 55_296_000,
            messageBytesReceived: 12_000,
            mmapFileBytesRead: 56_000_000,
            mmapReadRetries: 1,
            mmapTornFramesDropped: 0,
            productionToReceiveLatencyMs: { p50: 4.2, p95: 8.1 },
            productionToUsableLatencyMs: { p50: 4.7, p95: 9.2 },
            protobufDecodeTimeMs: { p50: 0.1, p95: 0.2 },
            mmapReadCopyTimeMs: { p50: 0.3, p95: 0.6 },
          },
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
  const capture = streamStatisticGroupMarkup(html, 'Capture statistics');

  expect(streamStatisticValue(capture, 'gRPC image mode')).toBe('MMAP');
  expect(streamStatisticValue(capture, 'Emulator producer FPS')).toBe('60 FPS');
  expect(streamStatisticValue(capture, 'Host receive FPS')).toBe('60 FPS');
  expect(streamStatisticValue(capture, 'Usable image FPS')).toBe('59 FPS');
  expect(streamStatisticValue(capture, 'Encoder input FPS')).toBe('59 FPS');
  expect(streamStatisticValue(capture, 'gRPC notifications')).toBe('600');
  expect(streamStatisticValue(capture, 'Selected notifications')).toBe('590');
  expect(streamStatisticValue(capture, 'Coalesced notifications')).toBe('10');
  expect(streamStatisticValue(capture, 'Latest image payload')).toBe('540.0 KiB');
  expect(streamStatisticValue(capture, 'Produce→usable p50 / p95')).toBe('4.7 / 9.2 ms');
  expect(streamStatisticValue(capture, 'MMAP read p50 / p95')).toBe('0.3 / 0.6 ms');
  expect(streamStatisticValue(capture, 'Torn frames dropped')).toBe('0');
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

  expect(selectValue(html, 'Stream transport')).toBe('WebSocket');
  expect(html).toContain('Start the standalone server with --transport webrtc');
});

test('renders every iOS device option as a select pill sized by its options', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);

  for (const [label, options, selected] of [
    ['Appearance', ['Light', 'Dark'], 'Light'],
    ['Liquid glass', ['Clear', 'Tinted'], 'Clear'],
    ['Color filter', ['None', 'Grayscale', 'Red-green', 'Green-red', 'Blue-yellow'], 'None'],
    ['Text size', ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'], 'L'],
  ] as const) {
    expect(rowOpeningTag(html, label)).toContain('padding:12px 0');
    expect(rowOpeningTag(html, label)).not.toContain('border-bottom:');
    expect(selectMarkup(html, label)).toContain('height:28px');
    expect(selectValue(html, label)).toBe(selected);
    expect(selectOptionLabels(html, label)).toEqual([...options]);
  }
});

test('maps Android device options onto Network and S–XL selects', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('android')} />);

  expect(selectOptionLabels(html, 'Network')).toEqual(['On', 'Off']);
  expect(selectValue(html, 'Network')).toBe('On');
  expect(selectOptionLabels(html, 'Text size')).toEqual(['S', 'M', 'L', 'XL']);
  expect(selectValue(html, 'Text size')).toBe('M');
});

test('keeps keyboard controls at the end of the device options list', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);
  const section = sectionMarkup(html, 'Device options');

  expect(section.indexOf('>Hardware keyboard</span>')).toBeGreaterThan(
    section.indexOf('>VoiceOver</span>'),
  );
  expect(section.indexOf('>Software keyboard</span>')).toBeGreaterThan(
    section.indexOf('>Hardware keyboard</span>'),
  );
  expect(section.match(/>Toggle</g)).toHaveLength(2);
});

test('stacks device option rows without dividers', () => {
  for (const platform of ['ios', 'android'] as const) {
    const html = renderToStaticMarkup(<LogSidebar client={inspectorClient(platform)} />);
    const section = sectionMarkup(html, 'Device options');

    expect(openingTag(section, '<section')).toContain('border-top:');
    expect(section).not.toContain('border-bottom:');
    expect(section.match(/padding:12px 0"/g)?.length).toBeGreaterThan(0);
  }
});

test('renders boolean device options as compact switches', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);
  const reduceMotion = switchMarkup(html, 'Reduce motion');

  expect(reduceMotion).toContain('role="switch"');
  expect(reduceMotion).toContain('aria-checked="false"');
  expect(reduceMotion).toContain('width:36px');
  expect(reduceMotion).toContain('height:20px');
  expect(reduceMotion).toContain('transform:translateX(0px)');
});

test('moves device actions into Device options and hides Remove for physical devices', () => {
  const android = renderToStaticMarkup(
    <LogSidebar
      client={inspectorClient('android')}
      device={device('android', 'android:pixel-10-pro')}
      onShutdown={() => {}}
      onRemove={() => {}}
    />,
  );
  const section = sectionMarkup(android, 'Device options');

  for (const label of ['Back button', 'Recents button', 'Shut down device', 'Remove device']) {
    expect(section).toContain(`>${label}</span>`);
  }
  expect(section.match(/>Press</g)).toHaveLength(2);
  expect(section).toContain('>Shut down<');
  expect(section).toContain('>Remove<');
  expect(section.indexOf('>Back button</span>')).toBeGreaterThan(section.indexOf('>Text size</span>'));

  const physical = renderToStaticMarkup(
    <LogSidebar
      client={inspectorClient('android')}
      device={{ ...device('android', 'android:pixel-10-pro'), physical: true }}
      onShutdown={() => {}}
      onRemove={() => {}}
    />,
  );
  expect(physical).toContain('>Shut down device</span>');
  expect(physical).not.toContain('>Remove device</span>');

  const ios = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} />);
  for (const label of ['Back button', 'Recents button', 'Shut down device', 'Remove device']) {
    expect(ios).not.toContain(`>${label}</span>`);
  }
});

test('styles sidebar action buttons like the select pills', () => {
  const html = renderToStaticMarkup(<LogSidebar client={inspectorClient('ios')} onShutdown={() => {}} />);
  const toggle = html.slice(html.lastIndexOf('<button', html.indexOf('>Toggle<')), html.indexOf('>Toggle<') + 1);
  const select = selectMarkup(html, 'Appearance');

  for (const style of ['height:28px', 'border:1px solid var(--expo-theme-border-default)', 'border-radius:var(--expo-radius-lg)', 'background-color:var(--expo-theme-background-element)', 'font-size:14px']) {
    expect(toggle).toContain(style);
    expect(select).toContain(style);
  }
});

test('disables only the pending Android device setting', () => {
  const client = {
    ...inspectorClient('android'),
    deviceSettingsPending: new Set(['network'] as const),
  };
  const html = renderToStaticMarkup(<LogSidebar client={client} />);

  expect(selectMarkup(html, 'Network')).toContain('disabled=""');
  expect(selectMarkup(html, 'Appearance')).not.toContain('disabled=""');
  expect(selectMarkup(html, 'Text size')).not.toContain('disabled=""');
});

test('disables only the device setting with an in-flight update', () => {
  const client = {
    ...inspectorClient('ios'),
    deviceSettingsPending: new Set(['appearance'] as const),
  };
  const html = renderToStaticMarkup(<LogSidebar client={client} />);

  expect(selectMarkup(html, 'Appearance')).toContain('disabled=""');
  expect(selectMarkup(html, 'Liquid glass')).not.toContain('disabled=""');
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
