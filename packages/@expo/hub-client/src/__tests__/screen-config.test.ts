import { describe, expect, test } from "bun:test";

import { screenConfigsEqual, screenSizesEqual, simScreenSize } from "../screen-config";

describe("screenConfigsEqual", () => {
  const inner = { width: 2007, height: 2853, orientation: "portrait" as const, screenId: 3 };

  test("treats a missing previous config as a change", () => {
    expect(screenConfigsEqual(null, inner)).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner })).toBe(true);
  });

  test("reports a display switch even when both screens have the same dimensions", () => {
    expect(screenConfigsEqual({ ...inner, screenId: 1 }, inner)).toBe(false);
  });

  test("reports hinge movement, a pose change, and Table Mode at the same geometry", () => {
    const open = {
      ...inner,
      supportsHingeAngle: true,
      hingeAngle: 180,
      hingePose: "open" as const,
    };
    expect(screenConfigsEqual(open, { ...open, hingeAngle: 90 })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, hingePose: null })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, tableMode: true })).toBe(false);
    expect(screenConfigsEqual(open, { ...open, tableModeAvailable: true })).toBe(false);
  });

  test("reports capability, physical orientation, and input availability changes", () => {
    expect(screenConfigsEqual(inner, { ...inner, supportsHingeAngle: true })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, supportsPhysicalOrientation: true })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, physicalOrientation: "facedown" })).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, inputUnavailable: true })).toBe(false);
  });
});

describe("simScreenSize", () => {
  const config = {
    width: 2007,
    height: 2853,
    orientation: "portrait" as const,
    screenId: 3,
    supportsHingeAngle: true,
    hingeAngle: 180,
    hingePose: "open" as const,
    tableMode: false,
  };

  test("keeps serve-sim's hinge fields and display ID out of the public screen", () => {
    expect(simScreenSize(config, true)).toEqual({
      width: 2007,
      height: 2853,
      orientation: "portrait",
      display: "inner",
    });
    expect(simScreenSize({ ...config, screenId: 1 }, true).display).toBe("cover");
  });

  test("names no display on a device that does not fold", () => {
    expect(simScreenSize(config, false)).toEqual({
      width: 2007,
      height: 2853,
      orientation: "portrait",
    });
  });

  test("compares only the public fields", () => {
    const screen = simScreenSize(config, true);
    expect(screenSizesEqual(screen, simScreenSize({ ...config, hingeAngle: 90 }, true))).toBe(true);
    expect(screenSizesEqual(screen, simScreenSize({ ...config, screenId: 1 }, true))).toBe(false);
    expect(screenSizesEqual(null, screen)).toBe(false);
    expect(screenSizesEqual(null, null)).toBe(true);
  });
});
