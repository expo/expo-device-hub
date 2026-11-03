import { describe, expect, test } from "bun:test";

import {
  isRotationReadback,
  observedScreenConfig,
  screenConfigsEqual,
  turnedPhysicalOrientation,
} from "../screen-config";

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

  test("reports an observation-only change and an observation that appears or goes", () => {
    const observed = {
      ...inner,
      hingeAngle: 180,
      observedDeviceState: { hingeAngle: 180, physicalOrientation: "portrait" as const },
    };
    const laptop = { hingeAngle: 90, physicalOrientation: "landscape-left" as const };
    expect(screenConfigsEqual(observed, { ...observed, observedDeviceState: laptop })).toBe(false);
    expect(
      screenConfigsEqual(observed, {
        ...observed,
        observedDeviceState: { ...observed.observedDeviceState, tableMode: true },
      }),
    ).toBe(false);
    expect(screenConfigsEqual(inner, { ...inner, observedDeviceState: {} })).toBe(false);
    expect(
      screenConfigsEqual(observed, {
        ...observed,
        observedDeviceState: { ...observed.observedDeviceState },
      }),
    ).toBe(true);
  });
});

describe("observedScreenConfig", () => {
  const open = {
    width: 2007,
    height: 2853,
    screenId: 3,
    hingeAngle: 180,
    hingePose: "open" as const,
    physicalOrientation: "portrait" as const,
    tableMode: false,
    tableModeAvailable: true,
  };

  test("keeps the command fields when the helper sends no observation", () => {
    expect(observedScreenConfig(open)).toBe(open);
  });

  test("lets the observation replace the command fields and names its preset", () => {
    const shown = observedScreenConfig({
      ...open,
      observedDeviceState: {
        hingeAngle: 90,
        physicalOrientation: "landscape-left",
        tableMode: false,
      },
    });
    expect(shown).toMatchObject({
      hingeAngle: 90,
      hingePose: "laptop",
      physicalOrientation: "landscape-left",
      tableMode: false,
      tableModeAvailable: true,
    });
  });

  test("leaves a field that the observation omits unknown, not the command's value", () => {
    const shown = observedScreenConfig({ ...open, observedDeviceState: { hingeAngle: 90 } });
    expect(shown.hingeAngle).toBe(90);
    expect(shown.physicalOrientation).toBeUndefined();
    expect(shown.tableMode).toBeUndefined();
    expect(shown.hingePose).toBeUndefined();
    expect(shown.tableModeAvailable).toBeUndefined();
  });
});

describe("isRotationReadback", () => {
  const open = { width: 2007, height: 2853, hingeAngle: 180, hingePose: "open" as const };
  const portrait = { hingeAngle: 180, physicalOrientation: "portrait" as const, tableMode: false };

  test("reads the cleared command pose when the helper sends no observation", () => {
    expect(isRotationReadback(open, "landscape-left")).toBe(false);
    expect(isRotationReadback({ ...open, hingePose: null }, "landscape-left")).toBe(true);
  });

  test("reads the observation, though the command pose stays", () => {
    const observed = { ...open, observedDeviceState: portrait };
    expect(isRotationReadback(observed, "landscape-left")).toBe(false);
    const turned = { ...portrait, physicalOrientation: "landscape-left" as const };
    expect(isRotationReadback({ ...open, observedDeviceState: turned }, "landscape-left")).toBe(
      true,
    );
    // A turned Laptop is Book, a preset, yet the orientation shows the turn.
    const book = { hingeAngle: 90, physicalOrientation: "portrait" as const, tableMode: false };
    expect(isRotationReadback({ ...open, observedDeviceState: book }, "portrait")).toBe(true);
  });

  test("another orientation change, such as a pose command's readback, is not the rotation", () => {
    expect(isRotationReadback({ ...open, observedDeviceState: portrait }, "pud")).toBe(false);
    // Without a known target, only the readback grace ends the rotation.
    expect(isRotationReadback({ ...open, observedDeviceState: portrait }, undefined)).toBe(false);
  });
});

describe("turnedPhysicalOrientation", () => {
  test("counts quarter turns clockwise as serve-sim's rotation tracker does", () => {
    // Measured on an iPhone Duo: Rotate from Laptop (landscape-left) lands upside down.
    expect(turnedPhysicalOrientation("landscape-left", 1)).toBe("pud");
    expect(turnedPhysicalOrientation("portrait", 1)).toBe("landscape-left");
    expect(turnedPhysicalOrientation("portrait", -1)).toBe("landscape-right");
    expect(turnedPhysicalOrientation("landscape-left", 2)).toBe("landscape-right");
  });

  test("has no target for a device that is not upright", () => {
    expect(turnedPhysicalOrientation("facedown", 1)).toBeUndefined();
    expect(turnedPhysicalOrientation(undefined, 1)).toBeUndefined();
  });
});
