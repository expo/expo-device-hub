import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { type DeviceClient, type DeviceScreenProps } from '@expo/hub-client';
import { type Device } from '../dashboard/data';
import { StreamControls } from '../dashboard/StreamControls';
import { StreamPanel } from '../dashboard/StreamPanel';

function buttonTags(markup: string) {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

describe('StreamControls', () => {
  test('locks Rotate and explains the pending recording check', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="light" onToggleAppearance={() => {}} recording="unknown" />,
    );
    const rotate = buttonTags(markup).find((tag) => tag.includes('aria-label="Rotate"'));
    expect(rotate).toContain('aria-disabled="true"');
    expect(rotate).toContain('Rotation is unavailable until recording status is known.');
  });
  test('explains why Rotate is unavailable during recording without disabling app controls', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="light" onToggleAppearance={() => {}} recording="recording" />,
    );
    const buttons = buttonTags(markup);
    const rotate = buttons.find((tag) => tag.includes('aria-label="Rotate"'));
    expect(rotate).toContain('aria-disabled="true"');
    expect(rotate).toContain('aria-description="Rotation is unavailable while recording."');
    for (const tag of buttons.filter((tag) => !tag.includes('aria-label="Rotate"'))) {
      expect(tag).not.toContain('disabled');
    }
  });
  test('groups Save, Theme, Home, and Reload in one pill and keeps Rotate separate', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="dark" onToggleAppearance={() => {}} />
    );
    const buttons = buttonTags(markup);

    expect(buttons.map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1])).toEqual([
      'Save',
      'Theme',
      'Home',
      'Reload',
      'Rotate',
    ]);
    expect(markup).toContain('role="toolbar"');
    expect(markup).not.toContain('More');
    expect(markup).not.toContain('Shutdown');
    expect(markup).not.toContain('Remove');

    const groups = [...markup.matchAll(/<div style="[^"]*border-radius:var\(--expo-radius-xl\)[^"]*"/g)];
    expect(groups).toHaveLength(2);
    expect(markup.indexOf('aria-label="Rotate"')).toBeGreaterThan(markup.lastIndexOf('border-radius:var(--expo-radius-xl)'));
  });

  test('shows the clipboard pill before Rotate, Copy first as in serve-sim, with only the actions the device offers', () => {
    const labels = (clipboard: { paste: boolean; copy: boolean } | false) =>
      buttonTags(
        renderToStaticMarkup(
          <StreamControls appearance="light" onToggleAppearance={() => {}} clipboard={clipboard} />,
        ),
      ).map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1]);
    const base = ['Save', 'Theme', 'Home', 'Reload'];

    expect(labels({ paste: true, copy: true })).toEqual([
      ...base,
      'Copy from Simulator',
      'Paste from Device',
      'Rotate',
    ]);
    expect(labels({ paste: true, copy: false })).toEqual([...base, 'Paste from Device', 'Rotate']);
    expect(labels({ paste: false, copy: true })).toEqual([...base, 'Copy from Simulator', 'Rotate']);
    expect(labels({ paste: false, copy: false })).toEqual([...base, 'Rotate']);
    expect(labels(false)).toEqual([...base, 'Rotate']);

    const markup = renderToStaticMarkup(
      <StreamControls
        appearance="light"
        onToggleAppearance={() => {}}
        clipboard={{ paste: true, copy: true }}
      />,
    );
    expect([...markup.matchAll(/<div style="[^"]*border-radius:var\(--expo-radius-xl\)[^"]*"/g)]).toHaveLength(3);
  });

  test('shows every label as a tooltip above its button and exposes Theme as a switch', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="dark" onToggleAppearance={() => {}} />
    );
    const tooltips = [...markup.matchAll(/<span role="tooltip"[^>]*>([^<]+)<\/span>/g)];

    expect(tooltips.map((match) => match[1])).toEqual(['Save', 'Theme', 'Home', 'Reload', 'Rotate']);
    for (const match of tooltips) {
      expect(match[0]).toContain('bottom:calc(100% + 8px)');
      expect(match[0]).toContain('opacity:0');
    }
    const theme = buttonTags(markup).find((tag) => tag.includes('aria-label="Theme"'));
    expect(theme).toContain('role="switch"');
    expect(theme).toContain('aria-checked="true"');
    for (const tag of buttonTags(markup)) {
      expect(tag).toContain('width:44px');
      expect(tag).toContain('height:44px');
    }
  });
});

describe('StreamPanel', () => {
  test('offers the clipboard actions of its client in the toolbar', () => {
    const device: Device = {
      id: 'ios',
      name: 'iPhone 17 Pro',
      version: 'iOS 27.0',
      platform: 'ios',
      booted: true,
      physical: false,
      supported: true,
      deviceFrame: 'ios:iphone-17-pro',
    };
    const toolbar = (clipboard: DeviceClient['capabilities']['clipboard']) =>
      renderToStaticMarkup(
        <StreamPanel
          device={device}
          client={{ status: 'streaming', capabilities: { clipboard } } as DeviceClient}
          DeviceScreen={() => null}
          displayScreen={() => null}
        />,
      );

    expect(toolbar({ paste: true, copy: false })).toContain('aria-label="Paste from Device"');
    expect(toolbar({ paste: true, copy: false })).not.toContain('aria-label="Copy from Simulator"');
    expect(toolbar(false)).not.toContain('aria-label="Paste from Device"');
  });

  test('gives DeviceScreen a pasteText that reports Command+V through the clipboard toasts', async () => {
    const pastes: Array<string | undefined> = [];
    const pasteText = async (text?: string) => void pastes.push(text);
    let screenClient: DeviceScreenProps['client'] | undefined;
    renderToStaticMarkup(
      <StreamPanel
        device={{
          id: 'ios',
          name: 'iPhone 17 Pro',
          version: 'iOS 27.0',
          platform: 'ios',
          booted: true,
          physical: false,
          supported: true,
          deviceFrame: 'ios:iphone-17-pro',
        }}
        client={
          {
            status: 'streaming',
            capabilities: { clipboard: { paste: true, copy: false } },
            pasteText,
          } as unknown as DeviceClient
        }
        DeviceScreen={({ client }) => {
          screenClient = client;
          return null;
        }}
        displayScreen={() => null}
      />,
    );

    expect(screenClient?.pasteText).toBeDefined();
    expect(screenClient?.pasteText).not.toBe(pasteText);
    await screenClient!.pasteText('typed');
    expect(pastes).toEqual(['typed']);
  });
});
