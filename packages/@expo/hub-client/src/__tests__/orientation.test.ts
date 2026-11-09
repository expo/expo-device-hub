import { describe, expect, test } from "bun:test";

import {
  CLOCKWISE_ORIENTATIONS,
  clockwiseQuarterTurns,
  displayDeltaForRawDelta,
  displayPointForRawPoint,
  HID_EDGE_BOTTOM,
  HOME_INDICATOR_BAND_NORM,
  homeIndicatorEdge,
  physicalOrientationForInterface,
  rawDeltaForDisplayDelta,
  rawPointForDisplayPoint,
  streamGeometry,
  turnedPhysicalOrientation,
} from "../orientation";
import type { DeviceOrientation } from "../types";

describe("homeIndicatorEdge", () => {
  test("tags a pointer begin inside the bottom band as the home-indicator edge", () => {
    expect(homeIndicatorEdge({ y: HOME_INDICATOR_BAND_NORM })).toBe(HID_EDGE_BOTTOM);
    expect(homeIndicatorEdge({ y: 0.99 })).toBe(HID_EDGE_BOTTOM);
  });

  test("leaves a begin above the band alone", () => {
    expect(homeIndicatorEdge({ y: 0.5 })).toBeUndefined();
    expect(homeIndicatorEdge({ y: HOME_INDICATOR_BAND_NORM - 0.001 })).toBeUndefined();
  });

  test("never tags a sample that opted out of edge gestures", () => {
    expect(homeIndicatorEdge({ y: 0.99, edgeGestures: false })).toBeUndefined();
  });
  test("the home band follows the interface relative to physical framing", () => {
    const base = { width: 1206, height: 2622, screenOrientation: "portrait" as const };
    expect(
      homeIndicatorEdge({ x: 0.99, y: 0.5 }, { ...base, deviceOrientation: "landscape-left" }),
    ).toBe(4);
    expect(
      homeIndicatorEdge({ x: 0.01, y: 0.5 }, { ...base, deviceOrientation: "landscape-right" }),
    ).toBe(1);
    expect(homeIndicatorEdge({ x: 0.5, y: 0.01 }, { ...base, deviceOrientation: "pud" })).toBe(2);
    expect(
      homeIndicatorEdge(
        { x: 0.5, y: 0.99 },
        { ...base, deviceOrientation: "landscape-left", screenOrientation: "landscape_right" },
      ),
    ).toBe(3);
    expect(
      homeIndicatorEdge(
        { x: 0.99, y: 0.5, edgeGestures: false },
        { ...base, deviceOrientation: "landscape-left" },
      ),
    ).toBeUndefined();
  });
});

describe("rawDeltaForDisplayDelta", () => {
  test("is the linear part of the point mapping", () => {
    // Moving from (0.5, 0.5) by (dx, dy) in display space must land where the
    // point mapping puts (0.5 + dx, 0.5 + dy).
    const dx = 0.1;
    const dy = -0.2;
    for (const orientation of [
      "portrait",
      "landscape_left",
      "landscape_right",
      "portrait_upside_down",
    ] as const) {
      const origin = rawPointForDisplayPoint(orientation, 0.5, 0.5);
      const moved = rawPointForDisplayPoint(orientation, 0.5 + dx, 0.5 + dy);
      const delta = rawDeltaForDisplayDelta(orientation, dx, dy);
      expect(delta.dx).toBeCloseTo(moved.x - origin.x);
      expect(delta.dy).toBeCloseTo(moved.y - origin.y);
    }
  });

  test("leaves portrait deltas untouched", () => {
    expect(rawDeltaForDisplayDelta(undefined, 0.25, 0.5)).toEqual({ dx: 0.25, dy: 0.5 });
  });
});

describe("streamGeometry", () => {
  test("turns raw serve-sim frames but leaves upright serve-emu frames alone", () => {
    const portrait = { width: 1080, height: 2400 };
    expect(streamGeometry({ ...portrait, orientation: "portrait_upside_down" })).toMatchObject({
      rotationDegrees: 180,
      inputOrientation: "portrait_upside_down",
    });
    expect(
      streamGeometry({ ...portrait, orientation: "portrait_upside_down", framesUpright: true }),
    ).toMatchObject({ rotationDegrees: 0, needsRotation: false, inputOrientation: undefined });
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

  test("turns between two interface orientations as far as between their physical ones", () => {
    expect(CLOCKWISE_ORIENTATIONS.map(physicalOrientationForInterface)).toEqual([
      "portrait",
      "landscape-left",
      "pud",
      "landscape-right",
    ]);
    for (const from of CLOCKWISE_ORIENTATIONS) {
      for (const to of CLOCKWISE_ORIENTATIONS) {
        expect(
          turnedPhysicalOrientation(
            physicalOrientationForInterface(from),
            clockwiseQuarterTurns(from, to),
          ),
        ).toBe(physicalOrientationForInterface(to));
      }
    }
  });
});

describe("displayPointForRawPoint", () => {
  const orientations: DeviceOrientation[] = [
    "portrait",
    "landscape_left",
    "landscape_right",
    "portrait_upside_down",
  ];

  test("undoes the display-to-raw mapping in every orientation", () => {
    for (const orientation of orientations) {
      const display = displayPointForRawPoint(orientation, 0.95, 0.75);
      const raw = rawPointForDisplayPoint(orientation, display.x, display.y);
      expect(raw.x).toBeCloseTo(0.95, 12);
      expect(raw.y).toBeCloseTo(0.75, 12);
      const delta = displayDeltaForRawDelta(orientation, 0.1, -0.2);
      const rawDelta = rawDeltaForDisplayDelta(orientation, delta.dx, delta.dy);
      expect(rawDelta.dx).toBeCloseTo(0.1, 12);
      expect(rawDelta.dy).toBeCloseTo(-0.2, 12);
    }
  });
});

describe("observed physical framing", () => {
  test("an externally turned phone keeps a landscape frame around a portrait-only app", () => {
    const geometry = streamGeometry({
      width: 1206,
      height: 2622,
      orientation: "landscape_left",
      screenOrientation: "portrait",
      deviceOrientation: "landscape-left",
    });
    expect(geometry.display).toMatchObject({
      width: 2622,
      height: 1206,
      orientation: "landscape_right",
    });
    expect(geometry.rotationDegrees).toBe(-90);
    expect(geometry.inputOrientation).toBe("landscape_right");
  });
  test("already-landscape pixels stay upright, or turn with a portrait device", () => {
    const pixels = { width: 2622, height: 1206, screenOrientation: "landscape_right" as const };
    expect(streamGeometry({ ...pixels, deviceOrientation: "landscape-left" }).rotationDegrees).toBe(
      0,
    );
    const portrait = streamGeometry({ ...pixels, deviceOrientation: "portrait" });
    expect(portrait.display).toMatchObject({ width: 1206, height: 2622 });
    expect(portrait.rotationDegrees).toBe(90);
    expect(portrait.inputOrientation).toBe("landscape_left");
  });
  test("unknown observed pose falls back to the native screen, not a cached command", () => {
    const geometry = streamGeometry({
      width: 1206,
      height: 2622,
      orientation: "landscape_right",
      screenOrientation: "portrait",
      deviceOrientation: null,
    });
    expect(geometry.display).toMatchObject({ width: 1206, height: 2622, orientation: "portrait" });
    expect(geometry.rotationDegrees).toBe(0);
  });
});
