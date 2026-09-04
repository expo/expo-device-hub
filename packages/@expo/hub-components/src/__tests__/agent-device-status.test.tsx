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
import { StreamPanel } from '../dashboard/StreamPanel';

const IPHONE: Device = {
  id: 'ios',
  name: 'iPhone 17 Pro',
  version: 'iOS 27.0',
  platform: 'ios',
  booted: true,
  physical: false,
  supported: true,
  deviceFrame: 'ios:iphone-17-pro',
};

const PIXEL: Device = {
  ...IPHONE,
  id: 'android',
  name: 'Pixel 10 Pro',
  version: 'Android 17.0',
  platform: 'android',
  deviceFrame: 'android:pixel-10-pro',
};

const FRAME_ASSETS: DeviceFrameAssets = {
  'android:pixel-10-pro': {
    src: '/pixel.png',
    width: 1250,
    height: 2631,
    screen: { x: 50, y: 48, width: 1138, height: 2532 },
    screenRadius: 150,
  },
  'ios:iphone-17-pro': {
    src: '/iphone.png',
    width: 2620,
    height: 5420,
    screen: { x: 104, y: 88, width: 2412, height: 5244 },
    screenRadius: 340,
  },
};

const STREAMING_CLIENT = { status: 'streaming' } as DeviceClient;
const LANDSCAPE_CLIENT = {
  status: 'streaming',
  screen: { width: 2400, height: 1080, orientation: 'landscape_left' },
} as DeviceClient;

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
    const frameStart = markup.indexOf('data-testid="device-screen-frame"');
    const frameTag = markup.slice(frameStart, markup.indexOf('>', frameStart) + 1);
    const overlayStart = markup.indexOf('data-testid="agent-device-overlay-clip"');
    const overlayTag = markup.slice(overlayStart, markup.indexOf('>', overlayStart) + 1);

    expect(screenClipTag).not.toContain('overflow:hidden');
    expect(screenClipTag).not.toContain('border-radius');
    expect(screenClipTag).not.toContain('corner-shape');
    expect(screenClipTag).toContain('clip-path:shape(');
    expect(frameTag).not.toContain('box-shadow');
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
    const frameStart = markup.indexOf('data-testid="device-screen-frame"');
    const frameTag = markup.slice(frameStart, markup.indexOf('>', frameStart) + 1);
    const streamStart = markup.indexOf('data-testid="device-frame-stream-cover"');
    const streamTag = markup.slice(streamStart, markup.indexOf('>', streamStart) + 1);
    const artworkStart = markup.indexOf('data-testid="device-frame-artwork"');
    const artworkTag = markup.slice(artworkStart, markup.indexOf('>', artworkStart) + 1);

    expect(markup).toContain('data-device-frame-kind="ios:iphone-17-pro"');
    expect(frameTag).toContain('flex-shrink:0');
    expect(frameTag).toContain('100cqw');
    expect(frameTag).toContain('cqh');
    expect(frameTag).not.toContain('100vh');
    expect(screenTag).toContain('left:calc(3.9695% - 1px)');
    expect(screenTag).toContain('top:calc(1.6236% - 1px)');
    expect(screenTag).toContain('width:calc(92.0611% + 2px)');
    expect(screenTag).toContain('height:calc(96.7528% + 2px)');
    expect(screenTag).toContain('container-type:size');
    expect(screenTag).toContain('overflow:hidden');
    expect(screenTag).not.toContain('--expo-device-frame-corner-shape');
    expect(screenTag).not.toContain('clip-path');
    expect(streamTag).toContain('top:50%;left:50%');
    expect(streamTag).toContain('width:max(100cqw, 46.043165cqh)');
    expect(streamTag).toContain('height:max(100cqh, 217.187500cqw)');
    expect(streamTag).toContain('aspect-ratio:0.460431654676259');
    expect(streamTag).not.toContain('calc(');
    expect(streamTag).toContain('transform:translate(-50%, -50%)');
    expect(streamStart).toBeLessThan(artworkStart);
    expect(artworkTag).toContain('src="/iphone.png"');
    expect(artworkTag).toContain('pointer-events:none');
    expect(artworkTag).toContain('z-index:2');

    const stableArtworkTags = [
      ...markup.matchAll(/<img[^>]*data-device-frame-artwork-kind="([^"]+)"[^>]*>/g),
    ];
    expect(stableArtworkTags).toHaveLength(2);
    expect(stableArtworkTags.map((match) => match[1]).sort()).toEqual([
      'android:pixel-10-pro',
      'ios:iphone-17-pro',
    ]);
    const pixelArtworkTag = stableArtworkTags.find(
      (match) => match[1] === 'android:pixel-10-pro',
    )?.[0];
    expect(pixelArtworkTag).toContain('src="/pixel.png"');
    expect(pixelArtworkTag).toContain('opacity:0');
    expect(pixelArtworkTag).not.toContain('data-testid="device-frame-artwork"');
  });

  test('gives every device state one panel-sized frame viewport', () => {
    const markup = renderToStaticMarkup(
      <StreamPanel
        device={IPHONE}
        client={{ ...STREAMING_CLIENT, status: 'connecting' }}
        deviceFrameAssets={FRAME_ASSETS}
        DeviceScreen={({ client }) => (
          <div data-testid="connection-state-surface" data-status={client.status} />
        )}
        displayScreen={() => null}
      />
    );
    const viewportStart = markup.indexOf('data-testid="device-frame-viewport"');
    const viewportTag = markup.slice(viewportStart, markup.indexOf('>', viewportStart) + 1);

    expect(viewportTag).toContain('container-type:size');
    expect(viewportTag).toContain('flex:1');
    expect(viewportTag).toContain('min-height:0');
    expect(viewportTag).toContain('width:100%');
    // The title and toolbar hug the frame: their heights are reserved as padding.
    expect(viewportTag).toContain('padding:48px 0 78px');
    expect(markup.indexOf('aria-label="Device controls"')).toBeGreaterThan(
      markup.indexOf('data-testid="device-frame-anchor"'),
    );
    expect(markup).toMatch(
      /data-testid="device-frame-viewport"[^>]*><div data-testid="device-frame-anchor"[^>]*><div data-testid="device-screen-frame"[\s\S]*data-testid="device-frame-stream-cover"[^>]*><div data-testid="connection-state-surface" data-status="connecting"><\/div>/
    );
  });

  test('rotates the expanded clip and aspect-cover stream for landscape frames', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        device={IPHONE}
        client={LANDSCAPE_CLIENT}
        deviceFrameAssets={FRAME_ASSETS}
        DeviceScreen={() => null}
        displayScreen={(screen) => screen ?? null}
      />
    );
    const screenStart = markup.indexOf('data-testid="device-screen-clip"');
    const screenTag = markup.slice(screenStart, markup.indexOf('>', screenStart) + 1);
    const streamStart = markup.indexOf('data-testid="device-frame-stream-cover"');
    const streamTag = markup.slice(streamStart, markup.indexOf('>', streamStart) + 1);
    const artworkStart = markup.indexOf('data-testid="device-frame-artwork"');
    const artworkTag = markup.slice(artworkStart, markup.indexOf('>', artworkStart) + 1);

    expect(screenTag).toContain('left:calc(1.6236% - 1px)');
    expect(screenTag).toContain('top:calc(3.9695% - 1px)');
    expect(screenTag).toContain('width:calc(96.7528% + 2px)');
    expect(screenTag).toContain('height:calc(92.0611% + 2px)');
    expect(streamTag).toContain('width:max(100cqw, 222.222222cqh)');
    expect(streamTag).toContain('height:max(100cqh, 45.000000cqw)');
    expect(streamTag).toContain('aspect-ratio:2.2222222222222223');
    expect(artworkTag).toContain('rotate(90deg)');
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
    expect(shown).toContain('data-device-frame-kind="android:pixel-10-pro"');
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
