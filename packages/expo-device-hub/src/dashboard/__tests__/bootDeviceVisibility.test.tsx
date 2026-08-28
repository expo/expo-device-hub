import { afterEach, describe, expect, test } from 'bun:test';
import { Sidebar } from '@expo/hub-components';
import { renderToStaticMarkup } from 'react-dom/server';

import { dashboardHideBootDevice } from '../../boot-device';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('dashboardHideBootDevice', () => {
  test('uses the preference provided by the standalone shell', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_HIDE_BOOT_DEVICE__: true };
    expect(dashboardHideBootDevice()).toBe(true);
  });

  test('keeps boot-device controls visible by default', () => {
    expect(dashboardHideBootDevice()).toBe(false);
  });
});

test('omits add-device buttons and their empty-state instructions without a handler', () => {
  const html = renderToStaticMarkup(
    <Sidebar
      simulators={[]}
      emulators={[]}
      recentSimulators={[]}
      recentEmulators={[]}
      simulatorOptions={{ runtimes: [] }}
      emulatorOptions={{ runtimes: [] }}
      selectedId=""
      onSelect={() => {}}
    />
  );

  expect(html).not.toContain('aria-label="Add simulator"');
  expect(html).not.toContain('aria-label="Add emulator"');
  expect(html).not.toContain('Use the + button');
});
