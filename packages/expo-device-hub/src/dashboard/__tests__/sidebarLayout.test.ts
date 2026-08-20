import { describe, expect, test } from 'bun:test';

import { resolveSidebarLayout } from '../useSidebarLayout';

const base = {
  leftPreference: 'auto' as const,
  rightPreference: 'auto' as const,
  leftWidth: 400,
  rightWidth: 400,
  minStreamWidth: 320,
};

describe('resolveSidebarLayout', () => {
  test('docks both automatically managed sidebars when they fit', () => {
    expect(resolveSidebarLayout({ ...base, containerWidth: 1200 })).toEqual({
      leftOpen: true,
      leftDocked: true,
      leftOverlay: false,
      rightOpen: true,
      rightDocked: true,
      rightOverlay: false,
    });
  });

  test('keeps the automatically managed left sidebar closed until both sidebars fit', () => {
    expect(resolveSidebarLayout({ ...base, containerWidth: 1119 })).toMatchObject({
      leftOpen: false,
      leftDocked: false,
      rightDocked: true,
    });
    expect(resolveSidebarLayout({ ...base, containerWidth: 1120 })).toMatchObject({
      leftOpen: true,
      leftDocked: true,
      rightDocked: true,
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

  test('never reopens a left sidebar the user hid', () => {
    expect(
      resolveSidebarLayout({ ...base, containerWidth: 1600, leftPreference: 'hidden' })
    ).toMatchObject({ leftOpen: false });
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
        leftPreference: 'open',
        rightPreference: 'open',
      })
    ).toMatchObject({ leftOverlay: true, rightOverlay: true });
  });

  test('only docks the left sidebar when it fits beside the docked right sidebar', () => {
    expect(
      resolveSidebarLayout({ ...base, containerWidth: 1000, leftPreference: 'open' })
    ).toMatchObject({
      leftDocked: false,
      leftOverlay: true,
      rightDocked: true,
    });
    expect(
      resolveSidebarLayout({ ...base, containerWidth: 1200, leftPreference: 'open' })
    ).toMatchObject({
      leftDocked: true,
      leftOverlay: false,
      rightDocked: true,
    });
  });
});
