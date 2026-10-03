import { describe, expect, test } from 'bun:test';

import {
  type DeviceDisplayChrome,
  displayChromeForScreen,
  displayCornerRadii,
} from '../display-corners';

// Xcode 27.1's DeviceKit profiles for the iPhone Duo, as serve-sim advertises them.
const INNER: DeviceDisplayChrome = {
  identifier: 'phone14',
  screen: { width: 626, height: 890 },
  screenRadius: 51.46487294469357,
  screenCornerRadii: {
    topLeft: 51.46487294469357,
    topRight: 51.46487294469357,
    bottomRight: 51.46487294469357,
    bottomLeft: 51.46487294469357,
  },
  screenId: 3,
};
const DUO: DeviceDisplayChrome = {
  identifier: 'phone15',
  screen: { width: 466, height: 678 },
  screenRadius: 33.5,
  screenCornerRadii: { topLeft: 8, topRight: 59, bottomRight: 59, bottomLeft: 8 },
  screenId: 1,
  displayVariants: { '1': { identifier: 'phone15', screen: { width: 466, height: 678 } }, '3': INNER },
};

describe('displayChromeForScreen', () => {
  test('selects the active display variant and falls back to the primary', () => {
    expect(displayChromeForScreen(DUO, 3)).toBe(INNER);
    expect(displayChromeForScreen(DUO, 1)?.identifier).toBe('phone15');
    expect(displayChromeForScreen(DUO, undefined)).toBe(DUO);
    expect(displayChromeForScreen(DUO, 7)).toBe(DUO);
  });
});

describe('displayCornerRadii', () => {
  test("the Duo's cover is nearly square at the hinge and round at its outer edge", () => {
    expect(displayCornerRadii(DUO, 'portrait')).toEqual({
      topLeft: 8 / 466,
      topRight: 59 / 466,
      bottomRight: 59 / 466,
      bottomLeft: 8 / 466,
    });
    // No reported orientation means portrait.
    expect(displayCornerRadii(DUO)).toEqual(displayCornerRadii(DUO, 'portrait'));
  });

  test('turns the physical corners with the device and measures them against the displayed width', () => {
    // serve-sim's order: landscape left puts the portrait top-left corner at the bottom left.
    expect(displayCornerRadii(DUO, 'landscape_left')).toEqual({
      topLeft: 8 / 678,
      topRight: 8 / 678,
      bottomRight: 59 / 678,
      bottomLeft: 59 / 678,
    });
    expect(displayCornerRadii(DUO, 'landscape_right')).toEqual({
      topLeft: 59 / 678,
      topRight: 59 / 678,
      bottomRight: 8 / 678,
      bottomLeft: 8 / 678,
    });
    expect(displayCornerRadii(DUO, 'portrait_upside_down')).toEqual({
      topLeft: 59 / 466,
      topRight: 8 / 466,
      bottomRight: 8 / 466,
      bottomLeft: 59 / 466,
    });
  });

  test('the inner display is round on every corner', () => {
    const corners = displayCornerRadii(INNER, 'portrait')!;
    for (const value of Object.values(corners)) expect(value).toBeCloseTo(51.46487294469357 / 626, 12);
  });

  test('uses the single radius when a profile has no per-corner values, and nothing without a screen', () => {
    expect(displayCornerRadii({ screen: { width: 400, height: 800 }, screenRadius: 40 })).toEqual({
      topLeft: 0.1,
      topRight: 0.1,
      bottomRight: 0.1,
      bottomLeft: 0.1,
    });
    expect(displayCornerRadii({ identifier: 'phone15' })).toBeNull();
    expect(displayCornerRadii({ screen: { width: 0, height: 800 }, screenRadius: 40 })).toBeNull();
    expect(displayCornerRadii({ screen: { width: 400, height: 800 } })).toBeNull();
  });
});
