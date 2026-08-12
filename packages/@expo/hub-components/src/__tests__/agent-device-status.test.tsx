import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceListItem } from '../components/DeviceListItem';
import { AgentDeviceOverlay } from '../dashboard/AgentDeviceOverlay';

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
    const hidden = renderToStaticMarkup(<AgentDeviceOverlay visible={false} />);
    const visible = renderToStaticMarkup(<AgentDeviceOverlay visible />);

    expect(hidden).toContain('hidden=""');
    expect(hidden).toContain('display:none');
    expect(visible).not.toContain('hidden=""');
    expect(visible).toContain('display:flex');
    expect(visible).not.toContain('border-radius');
    expect(visible).toContain('Agent is using this device');
  });
});
