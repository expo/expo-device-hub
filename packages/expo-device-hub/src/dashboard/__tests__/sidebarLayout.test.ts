import { describe, expect, test } from 'bun:test';

import { resolveSidebarLayout } from '../useSidebarLayout';

const base = {
  leftOpen: false,
  rightPreference: 'auto' as const,
  leftWidth: 400,
  rightWidth: 400,
  minStreamWidth: 320,
};

describe('resolveSidebarLayout', () => {
  test('starts with the left sidebar closed and docks the right sidebar when it fits', () => {
    expect(resolveSidebarLayout({ ...base, containerWidth: 1200 })).toEqual({
      leftDocked: false,
      leftOverlay: false,
      rightOpen: true,
      rightDocked: true,
      rightOverlay: false,
    });
  });

  test('keeps an automatically managed right sidebar closed when it does not fit', () => {
    expect(resolveSidebarLayout({ ...base, containerWidth: 719 })).toMatchObject({
      rightOpen: false,
      rightDocked: false,
      rightOverlay: false,
    });
    expect(resolveSidebarLayout({ ...base, containerWidth: 720 })).toMatchObject({
      rightOpen: true,
      rightDocked: true,
      rightOverlay: false,
    });
  });

  test('never reopens a right sidebar the user hid', () => {
    expect(
      resolveSidebarLayout({ ...base, containerWidth: 1600, rightPreference: 'hidden' })
    ).toMatchObject({ rightOpen: false });
  });

  test('overlays a sidebar explicitly opened without enough room', () => {
    expect(
      resolveSidebarLayout({ ...base, containerWidth: 390, rightPreference: 'open' })
    ).toMatchObject({ rightOpen: true, rightDocked: false, rightOverlay: true });
  });

  test('allows both explicitly opened sidebars to overlap on mobile', () => {
    expect(
      resolveSidebarLayout({
        ...base,
        containerWidth: 390,
        leftOpen: true,
        rightPreference: 'open',
      })
    ).toMatchObject({ leftOverlay: true, rightOverlay: true });
  });

  test('only docks the left sidebar when it fits beside the docked right sidebar', () => {
    expect(resolveSidebarLayout({ ...base, containerWidth: 1000, leftOpen: true })).toMatchObject({
      leftDocked: false,
      leftOverlay: true,
      rightDocked: true,
    });
    expect(resolveSidebarLayout({ ...base, containerWidth: 1200, leftOpen: true })).toMatchObject({
      leftDocked: true,
      leftOverlay: false,
      rightDocked: true,
    });
  });
});
