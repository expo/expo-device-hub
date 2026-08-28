import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { type DeviceClient } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceListItem } from '../components/DeviceListItem';
import { shouldCompactAgentDeviceStatus } from '../components/useCompactAgentDeviceStatus';
import { AgentDeviceOverlay } from '../dashboard/AgentDeviceOverlay';
import { type Device } from '../dashboard/data';
import { type DeviceFrameAssets } from '../dashboard/deviceFrame';
import { PhoneFrame } from '../dashboard/PhoneFrame';

const IPHONE: Device = {
  id: 'ios',
  name: 'iPhone 17 Pro',
  version: 'iOS 27.0',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'iphone',
};

const PIXEL: Device = {
  ...IPHONE,
  id: 'android',
  name: 'Pixel 10 Pro',
  version: 'Android 17.0',
  platform: 'android',
  deviceFrame: 'pixel',
};

const FRAME_ASSETS: DeviceFrameAssets = {
  pixel: {
    src: '/pixel.png',
    width: 1250,
    height: 2631,
    screen: { x: 50, y: 48, width: 1138, height: 2532 },
    screenRadius: 150,
    screenSuperellipse: 1,
  },
  iphone: {
    src: '/iphone.png',
    width: 2620,
    height: 5420,
    screen: { x: 104, y: 88, width: 2412, height: 5244 },
    screenRadius: 512,
    screenSuperellipse: 1.57,
  },
};

const STREAMING_CLIENT = { status: 'streaming' } as DeviceClient;

describe('agent device status', () => {
  test('labels active device rows and renders the blue status badge', () => {
    const markup = renderToStaticMarkup(
      <DeviceListItem name="iPhone 16 Pro" version="iOS 18.6" usedByAgent />
    );

    expect(markup).toContain('aria-label="iPhone 16 Pro, iOS 18.6, used by agent"');
    expect(markup).toContain('data-agent-device-status="active"');
    expect(markup).toContain('data-agent-device-badge="true"');
    expect(markup).toContain('Used by agent');
  });

  test('keeps inactive status space reserved without exposing the status', () => {
    const markup = renderToStaticMarkup(<DeviceListItem name="iPhone 16" version="iOS 26.5" />);

    expect(markup).toContain('data-agent-device-status="inactive"');
    expect(markup).toContain('visibility:hidden');
    expect(markup).not.toContain('aria-label="iPhone 16, iOS 26.5, used by agent"');
  });

  test('keeps long device rows contained and compacts agent status when needed', () => {
    const markup = renderToStaticMarkup(
      <DeviceListItem name="Medium_Phone_API_36.1" version="Android 16.0" usedByAgent />
    );
    const buttonTag = markup.slice(0, markup.indexOf('>') + 1);

    expect(buttonTag).toContain('width:100%');
    expect(buttonTag).toContain('min-width:0');
    expect(buttonTag).toContain('box-sizing:border-box');
    expect(buttonTag).toContain('overflow:hidden');
    expect(
      shouldCompactAgentDeviceStatus({
        available: 176,
        name: 172,
        version: 82,
        badge: 7,
        label: 66,
      })
    ).toBeTrue();
    expect(
      shouldCompactAgentDeviceStatus({
        available: 380,
        name: 60,
        version: 58,
        badge: 7,
        label: 66,
      })
    ).toBeFalse();
  });

  test('only reveals the phone overlay while hover state is active', () => {
    const hidden = renderToStaticMarkup(
      <AgentDeviceOverlay visible={false} onTakeOver={() => {}} />
    );
    const visible = renderToStaticMarkup(<AgentDeviceOverlay visible onTakeOver={() => {}} />);
    const visibleOverlayTag = visible.slice(0, visible.indexOf('>') + 1);

    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain('display:none');
    expect(visible).not.toContain('hidden=""');
    expect(visible).toContain('display:flex');
    expect(visibleOverlayTag).not.toContain('border-radius');
    expect(visible).toContain('color:rgba(218, 233, 255, 0.74)');
    expect(visibleOverlayTag).not.toContain('backdrop-filter');
    expect(visibleOverlayTag).toContain('background-color:rgba(0, 0, 0, 0.55)');
    expect(visible).toContain('Agent is using this device');
    expect(visible).toContain('color:rgba(255, 255, 255, 0.7)');
    expect(visible).toContain('Taking over might collide with what the agent is doing.');
    expect(visible).toContain('Take over anyway');
    expect(visible).toContain('background-color:var(--expo-theme-button-agent-overlay-background)');
    expect(visible).toContain('font-family:inherit');
    expect(visible).toContain(
      '<span style="font-size:12px;font-weight:500;line-height:1.6;letter-spacing:0">Take over anyway</span>'
    );
  });

  test('keeps the agent takeover button borderless in light mode', () => {
    const themeCss = readFileSync(new URL('../theme/theme.css', import.meta.url), 'utf8');
    const lightTheme = themeCss.slice(themeCss.indexOf(':root {'), themeCss.indexOf('.dark-theme'));

    expect(lightTheme).toContain('--expo-theme-button-agent-overlay-border: transparent;');
    expect(lightTheme).toContain('--expo-theme-button-agent-overlay-disabled-border: transparent;');
  });

  test('clips the stream and unshaped overlay with one shared iOS screen shape', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={{ ...IPHONE, deviceFrame: null }}
        DeviceScreen={() => null}
        displayScreen={() => null}
      />
    );
    const screenClipStart = markup.indexOf('data-testid="device-screen-clip"');
    const screenClipTag = markup.slice(screenClipStart, markup.indexOf('>', screenClipStart) + 1);
    const overlayStart = markup.indexOf('data-testid="agent-device-overlay-clip"');
    const overlayTag = markup.slice(overlayStart, markup.indexOf('>', overlayStart) + 1);

    expect(screenClipTag).not.toContain('overflow:hidden');
    expect(screenClipTag).not.toContain('border-radius');
    expect(screenClipTag).not.toContain('corner-shape');
    expect(screenClipTag).toContain('clip-path:shape(');
    expect(overlayTag).not.toContain('overflow:hidden');
    expect(overlayTag).not.toContain('border-radius');
    expect(overlayTag).not.toContain('corner-shape');
  });

  test('clips the stream to the calibrated opening below iPhone artwork', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={IPHONE}
        deviceFrameAssets={FRAME_ASSETS}
        DeviceScreen={() => null}
        displayScreen={() => null}
      />
    );
    const screenStart = markup.indexOf('data-testid="device-screen-clip"');
    const screenTag = markup.slice(screenStart, markup.indexOf('>', screenStart) + 1);
    const artworkStart = markup.indexOf('data-testid="device-frame-artwork"');
    const artworkTag = markup.slice(artworkStart, markup.indexOf('>', artworkStart) + 1);

    expect(markup).toContain('data-device-frame-kind="iphone"');
    expect(screenTag).toContain('left:3.9695%');
    expect(screenTag).toContain('top:1.6236%');
    expect(screenTag).toContain('width:92.0611%');
    expect(screenTag).toContain('height:96.7528%');
    expect(screenTag).toContain('overflow:hidden');
    expect(screenTag).toContain('--expo-device-frame-corner-shape:superellipse(1.57)');
    expect(screenTag).toContain('clip-path:shape(');
    expect(markup.indexOf('data-testid="device-frame-stream-cover"')).toBeLessThan(artworkStart);
    expect(artworkTag).toContain('src="/iphone.png"');
    expect(artworkTag).toContain('pointer-events:none');
    expect(artworkTag).toContain('z-index:2');
  });

  test('selects Pixel artwork by default and removes it when the viewer hides frames', () => {
    const StableDeviceScreen = () => <div data-testid="stable-device-screen" />;
    const shown = renderToStaticMarkup(
      <PhoneFrame
        device={PIXEL}
        client={STREAMING_CLIENT}
        deviceFrameAssets={FRAME_ASSETS}
        DeviceScreen={StableDeviceScreen}
        displayScreen={() => null}
      />
    );
    const hidden = renderToStaticMarkup(
      <PhoneFrame
        device={PIXEL}
        client={STREAMING_CLIENT}
        deviceFrameAssets={FRAME_ASSETS}
        showDeviceFrame={false}
        DeviceScreen={StableDeviceScreen}
        displayScreen={() => null}
      />
    );

    expect(shown).toContain('data-device-frame-kind="pixel"');
    expect(shown).toContain('src="/pixel.png"');
    expect(hidden).toContain('data-device-frame-kind="none"');
    expect(hidden).not.toContain('data-testid="device-frame-artwork"');
    for (const markup of [shown, hidden]) {
      expect(markup).toMatch(
        /data-testid="device-frame-stream-cover"[^>]*><div data-testid="stable-device-screen"><\/div><\/div>/
      );
    }
  });
});
