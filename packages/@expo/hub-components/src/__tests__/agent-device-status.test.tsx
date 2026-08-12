import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceListItem } from '../components/DeviceListItem';
import { AgentDeviceOverlay } from '../dashboard/AgentDeviceOverlay';
import { PhoneFrame } from '../dashboard/PhoneFrame';

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

  test('only reveals the phone overlay while hover state is active', () => {
    const hidden = renderToStaticMarkup(<AgentDeviceOverlay visible={false} onTakeOver={() => {}} />);
    const visible = renderToStaticMarkup(<AgentDeviceOverlay visible onTakeOver={() => {}} />);
    const visibleOverlayTag = visible.slice(0, visible.indexOf('>') + 1);

    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain('display:none');
    expect(visible).not.toContain('hidden=""');
    expect(visible).toContain('display:flex');
    expect(visibleOverlayTag).not.toContain('border-radius');
    expect(visible).toContain('color:var(--expo-theme-text-info)');
    expect(visibleOverlayTag).not.toContain('backdrop-filter');
    expect(visibleOverlayTag).not.toContain('background-color');
    expect(visible).toContain('Agent is using this device');
    expect(visible).toContain('Taking over might collide with what the agent is doing.');
    expect(visible).toContain('Take over anyway');
    expect(visible).toContain(
      'background-color:var(--expo-theme-button-agent-overlay-background)'
    );
    expect(visible).toContain('font-family:inherit');
    expect(visible).toContain(
      '<span style="font-size:14px;font-weight:500;line-height:1.6;letter-spacing:0">Take over anyway</span>'
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
        platform="ios"
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
});
