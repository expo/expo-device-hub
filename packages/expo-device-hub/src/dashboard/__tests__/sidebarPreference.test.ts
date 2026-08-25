import { afterEach, describe, expect, test } from 'bun:test';

import { dashboardHideSidebar } from '../../sidebar';

afterEach(() => {
  delete (globalThis as any).window;
});

describe('dashboardHideSidebar', () => {
  test('uses the preference provided by the standalone shell', () => {
    (globalThis as any).window = { __EXPO_DEVICE_HUB_HIDE_SIDEBAR__: true };
    expect(dashboardHideSidebar()).toBe(true);
  });

  test('keeps the sidebar visible by default', () => {
    expect(dashboardHideSidebar()).toBe(false);
  });
});
