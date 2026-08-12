import { describe, expect, test } from 'bun:test';
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
    expect(visible).toContain('backdrop-filter:blur(18px) saturate(120%)');
    expect(visible).toContain('Agent is using this device');
    expect(visible).toContain('Taking over might collide with what the agent is doing.');
    expect(visible).toContain('Take over anyway');
  });

  test('clips the unshaped overlay with the same iOS screen shape', () => {
    const markup = renderToStaticMarkup(
      <PhoneFrame
        platform="ios"
        DeviceScreen={() => null}
        displayScreen={() => null}
      />
    );

    expect(markup).toContain('data-testid="agent-device-overlay-clip"');
    expect(markup).toContain('overflow:hidden');
    expect(markup).toContain('border-radius:14.066cqw');
    expect(markup).toContain('corner-shape:superellipse(1.3)');
  });
});
