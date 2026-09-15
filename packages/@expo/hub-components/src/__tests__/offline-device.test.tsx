import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { type DeviceClient } from '@expo/hub-client';
import { NOOP_DEVICE_CLIENT } from '../../../hub-client/src/useNoopDeviceClient';
import { DeviceListItem } from '../components/DeviceListItem';
import { type Device } from '../dashboard/data';
import { type DeviceFrameAssets } from '../dashboard/deviceFrame';
import { DeviceOptionsSection } from '../dashboard/DeviceOptionsSection';
import { DeviceSection } from '../dashboard/DeviceSection';
import { LogControls } from '../dashboard/LogControls';
import { LogSidebar } from '../dashboard/LogSidebar';
import { PhoneFrame } from '../dashboard/PhoneFrame';
import { RecentDevicesModal } from '../dashboard/RecentDevicesModal';
import { Select } from '../components/Select';
import { StreamOptionsSection } from '../dashboard/StreamOptionsSection';
import { StreamPanel } from '../dashboard/StreamPanel';

const DEVICE: Device = {
  id: 'A671E25C-3A15-4738-8B49-8FACD3AE5ACD',
  name: 'iPhone 17 Pro',
  version: 'iOS 27.0',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};

const FRAME_ASSET = {
  src: '/iphone.png',
  width: 2620,
  height: 5420,
  screen: { x: 104, y: 88, width: 2412, height: 5244 },
  screenRadius: 340,
};

const FRAME_ASSETS: DeviceFrameAssets = {
  'ios:iphone-17-pro': FRAME_ASSET,
  'android:pixel-9': FRAME_ASSET,
  'android:pixel-10-pro': FRAME_ASSET,
};

const CLIENT: DeviceClient = {
  ...NOOP_DEVICE_CLIENT,
  status: 'streaming',
  appearance: 'dark',
  hardwareKeyboardConnected: true,
  deviceSettings: { appearance: 'dark', 'text-size': 'large' },
  capabilities: {
    ...NOOP_DEVICE_CLIENT.capabilities,
    deviceSettings: true,
    streamSettings: { maxDimension: true },
  },
  streamSettings: {
    mjpegFps: 30,
    mjpegQuality: 0.7,
    maxDimension: 1920,
    h264Bitrate: 6000000,
    h264Fps: 30,
  },
  streamCapabilities: {
    modeAvailability: { mjpeg: true, h264: true, webrtc: true },
    httpCodecs: ['auto', 'h264', 'mjpeg'],
    webRtcCodecs: ['h264'],
  },
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function buttonTags(markup: string) {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

function buttonNamed(markup: string, name: string) {
  const button = buttonTags(markup).find((tag) => tag.includes(`aria-label="${name}"`));
  expect(button).toBeDefined();
  return button!;
}

function elementTag(markup: string, testId: string) {
  return markup.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0];
}

describe('offline selected device', () => {
  test('retains landscape geometry after the client resets, and clears it when switching devices', async () => {
    let renderer: ReactTestRenderer;
    const props = {
      device: DEVICE,
      DeviceScreen: () => <div data-testid="live-screen" />,
      displayScreen: (screen: DeviceClient['screen'] = null) => screen,
      deviceFrameAssets: FRAME_ASSETS,
    };
    const client = {
      ...CLIENT,
      screen: { width: 2400, height: 1080, orientation: 'landscape_right' as const },
    };
    await act(() => {
      renderer = create(<PhoneFrame {...props} client={client} />);
    });
    try {
      const frame = renderer!.root.findByProps({ 'data-testid': 'device-screen-frame' });
      const artwork = renderer!.root.findByProps({ 'data-testid': 'device-frame-artwork' });
      const frameStyle = frame.props.style;
      const artworkStyle = artwork.props.style;

      await act(() => {
        renderer!.update(<PhoneFrame {...props} client={NOOP_DEVICE_CLIENT} available={false} />);
      });
      expect(renderer!.root.findByProps({ 'data-testid': 'device-screen-frame' })).toBe(frame);
      expect(frame.props.style).toEqual(frameStyle);
      expect(artwork.props.style).toEqual(artworkStyle);
      expect(artwork.props.style.transform).toContain('rotate(-90deg)');
      expect(
        renderer!.root.findAllByProps({ 'data-testid': 'device-unavailable-screen' })
      ).toHaveLength(1);

      await act(() => {
        renderer!.update(
          <PhoneFrame
            {...props}
            device={{ ...DEVICE, id: 'another-device' }}
            client={NOOP_DEVICE_CLIENT}
            available={false}
          />
        );
      });
      expect(artwork.props.style.transform).toContain('rotate(0deg)');
    } finally {
      await act(() => renderer!.unmount());
    }
  });

  test('retains inspector values when the client resets and clears them for a different device', async () => {
    // The renderer has no DOM nodes; these browser globals support the closed
    // Radix selects and reduced-motion subscriptions exercised by the inspector.
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const previousForm = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { clearTimeout, setTimeout },
    });
    Object.defineProperty(globalThis, 'HTMLFormElement', { configurable: true, value: class {} });
    let renderer: ReactTestRenderer;
    const props = {
      device: DEVICE,
      onShowDeviceFrameChange: () => {},
      onShutdown: () => {},
      onRemove: () => {},
    };
    try {
      await act(() => {
        renderer = create(<LogSidebar {...props} client={CLIENT} />);
      });
      const deviceOptions = renderer!.root.findByType(DeviceOptionsSection);
      await act(() => {
        renderer!.update(<LogSidebar {...props} client={NOOP_DEVICE_CLIENT} available={false} />);
      });
      expect(renderer!.root.findByType(DeviceOptionsSection)).toBe(deviceOptions);
      expect(deviceOptions.props.client).toBe(CLIENT);
      expect(deviceOptions.props.available).toBeFalse();
      const appearance = renderer!.root
        .findAllByType(Select)
        .find((node) => node.props.ariaLabel === 'Appearance');
      expect(appearance?.props.value).toBe('dark');
      expect(appearance?.props.disabled).toBeTrue();
      expect(renderer!.root.findAllByType(StreamOptionsSection)).toHaveLength(1);

      await act(() => {
        renderer!.update(
          <LogSidebar
            {...props}
            device={{ ...DEVICE, id: 'another-device' }}
            client={NOOP_DEVICE_CLIENT}
            available={false}
          />
        );
      });
      expect(deviceOptions.props.client).toBe(NOOP_DEVICE_CLIENT);
      expect(renderer!.root.findAllByType(StreamOptionsSection)).toHaveLength(0);
    } finally {
      await act(() => renderer?.unmount());
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      if (previousForm) Object.defineProperty(globalThis, 'HTMLFormElement', previousForm);
      else Reflect.deleteProperty(globalThis, 'HTMLFormElement');
    }
  });

  test('offers the retained offline device in the restart picker', async () => {
    let renderer: ReactTestRenderer;
    const props = {
      title: 'Simulators',
      addLabel: 'Add simulator',
      kind: 'simulator' as const,
      emptyLabel: 'No booted simulators.',
      devices: [DEVICE],
      recent: [DEVICE],
      options: { runtimes: [] },
      selectedId: DEVICE.id,
      onSelect: () => {},
    };
    await act(() => {
      renderer = create(<DeviceSection {...props} offlineDeviceId={DEVICE.id} />);
    });
    try {
      expect(renderer!.root.findByType(RecentDevicesModal).props.devices).toEqual([DEVICE]);
      await act(() => renderer!.update(<DeviceSection {...props} />));
      expect(renderer!.root.findByType(RecentDevicesModal).props.devices).toEqual([]);
    } finally {
      await act(() => renderer!.unmount());
    }
  });

  test('replaces the stream inside the same frame and keeps the title and toolbar', () => {
    const panelProps = {
      device: DEVICE,
      client: CLIENT,
      DeviceScreen: () => <div data-testid="live-screen" />,
      displayScreen: () => null,
      deviceFrameAssets: FRAME_ASSETS,
    };
    const live = renderToStaticMarkup(<StreamPanel {...panelProps} />);
    const offline = renderToStaticMarkup(<StreamPanel {...panelProps} available={false} />);

    expect(live).toContain('data-testid="live-screen"');
    expect(offline).not.toContain('data-testid="live-screen"');
    expect(offline).not.toContain('data-testid="agent-device-overlay-clip"');
    expect(offline).toContain('role="status" aria-live="polite"');
    expect(offline).toContain('Device unavailable');
    expect(offline).toContain('This device is offline. Its screen will return when it reconnects.');
    expect(offline).toContain('>Offline</span>');
    expect(offline).not.toContain('>Live</span>');
    for (const testId of [
      'device-frame-viewport',
      'device-screen-frame',
      'device-screen-clip',
      'device-frame-artwork',
    ]) {
      expect(elementTag(offline, testId)).toBe(elementTag(live, testId));
    }
    for (const name of ['Save', 'Theme', 'Home', 'Reload', 'Rotate']) {
      expect(buttonNamed(offline, name)).toContain('disabled=""');
      expect(buttonNamed(live, name)).not.toContain('disabled=""');
    }
  });

  test('labels a retained sidebar row Offline and clears its agent status', () => {
    const markup = renderToStaticMarkup(
      <DeviceListItem name={DEVICE.name} version={DEVICE.version} offline selected usedByAgent />
    );

    expect(markup).toContain('aria-label="iPhone 17 Pro, iOS 27.0, Offline"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('>Offline</span>');
    expect(markup).toContain('data-agent-device-status="inactive"');
    expect(buttonTags(markup)[0]).not.toContain('disabled');
  });

  test('keeps device options in place with backend controls disabled and the frame toggle usable', () => {
    const props = {
      client: CLIENT,
      deviceFrame: { available: true, visible: true, onVisibleChange: () => {} },
      onShutdown: () => {},
      onRemove: () => {},
    };
    const live = renderToStaticMarkup(<DeviceOptionsSection {...props} />);
    const offline = renderToStaticMarkup(<DeviceOptionsSection {...props} available={false} />);
    const liveButtons = buttonTags(live);
    const offlineButtons = buttonTags(offline);

    expect(offlineButtons).toHaveLength(liveButtons.length);
    expect(buttonNamed(offline, 'Appearance')).toContain('disabled=""');
    expect(buttonNamed(offline, 'Text size')).toContain('disabled=""');
    expect(buttonNamed(offline, 'Show device frame')).not.toContain('disabled=""');
    expect(offline).toContain('Hardware keyboard');
    expect(offline).toContain('Software keyboard');
    expect(offline).toContain('Shut down device');
    expect(offline).toContain('Remove device');
    // Only the section collapse button and viewer-local frame toggle remain enabled.
    expect(offlineButtons.filter((tag) => !tag.includes('disabled=""'))).toHaveLength(2);
  });

  test('keeps transport and HTTP codec preferences available while disabling host encoder controls', () => {
    const markup = renderToStaticMarkup(
      <StreamOptionsSection
        client={CLIENT}
        available={false}
        defaultOpen
        onStreamModeChange={() => {}}
        onHttpCodecChange={() => {}}
      />
    );

    expect(buttonNamed(markup, 'Stream transport')).not.toContain('disabled=""');
    expect(buttonNamed(markup, 'HTTP codec')).not.toContain('disabled=""');
    expect(buttonNamed(markup, 'Max size')).toContain('disabled=""');
  });

  test('disables log collection controls while the selected device is unavailable', () => {
    const markup = renderToStaticMarkup(
      <LogControls
        count={8}
        running={false}
        disabled
        onStart={() => {}}
        onStop={() => {}}
        onClear={() => {}}
      />
    );
    expect(buttonTags(markup)).toHaveLength(2);
    expect(buttonTags(markup).every((tag) => tag.includes('disabled=""'))).toBeTrue();
  });
});

test('disables the upstream hardware encoder control while retaining the offline selection', () => {
  const client: DeviceClient = {
    ...CLIENT,
    platform: 'android',
    streamSource: {
      mode: 'grpc-screenshot',
      grpcImageMode: 'rgb888',
      encoder: 'hardware',
      encoderName: 'h264_videotoolbox',
      availableEncoders: ['software', 'hardware'],
      inputSource: 'grpc',
      availableInputSources: ['grpc', 'scrcpy'],
      availableModes: ['grpc-screenshot', 'scrcpy'],
      sessionGeneration: 1,
    },
  };
  const html = renderToStaticMarkup(
    <StreamOptionsSection client={client} available={false} defaultOpen />
  );
  expect(buttonNamed(html, 'gRPC encoder')).toContain('disabled');
  expect(html).toContain('Hardware');
  expect(html).toContain('h264_videotoolbox');
});
