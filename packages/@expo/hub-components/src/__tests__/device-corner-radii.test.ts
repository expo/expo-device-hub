import { describe, expect, test } from "bun:test";

import { cornerRadiiBorderRadius, orientedCornerRadiiCqw } from "../dashboard/deviceCornerRadii";
import { deviceScreenClipPath } from "../dashboard/deviceScreenClipPath";

// iPhone Duo's primary display: small corners on the left, large on the right.
const duo = { topLeft: 0.02, topRight: 0.12, bottomRight: 0.12, bottomLeft: 0.02 };
// Distinct per corner so every remap is visible.
const distinct = { topLeft: 0.01, topRight: 0.02, bottomRight: 0.03, bottomLeft: 0.04 };

describe("orientedCornerRadiiCqw", () => {
  test("scales a portrait fraction to cqw of the rendered width", () => {
    expect(orientedCornerRadiiCqw(duo, "portrait", 0.46)).toEqual({
      topLeft: 2,
      topRight: 12,
      bottomRight: 12,
      bottomLeft: 2,
    });
  });

  test("keeps the physical size in landscape by dividing by the aspect ratio", () => {
    const landscape = orientedCornerRadiiCqw(distinct, "landscape_left", 2);

    expect(landscape.topLeft).toBeCloseTo(2, 6);
  });

  test("moves each corner with the device rotation", () => {
    const at = (orientation: Parameters<typeof orientedCornerRadiiCqw>[1], ratio: number) =>
      Object.values(orientedCornerRadiiCqw(distinct, orientation, ratio)).map((cqw) =>
        Math.round((cqw * Math.max(ratio, 1)) / 100 / 0.01),
      );

    // Order is topLeft, topRight, bottomRight, bottomLeft; values are 1..4.
    expect(at("portrait", 0.5)).toEqual([1, 2, 3, 4]);
    expect(at("landscape_left", 2)).toEqual([4, 1, 2, 3]);
    expect(at("landscape_right", 2)).toEqual([2, 3, 4, 1]);
    expect(at("portrait_upside_down", 0.5)).toEqual([3, 4, 1, 2]);
  });

  test("falls back to the display aspect when no orientation is known", () => {
    expect(orientedCornerRadiiCqw(distinct, undefined, 2)).toEqual(
      orientedCornerRadiiCqw(distinct, "landscape_left", 2),
    );
  });
});

describe("cornerRadiiBorderRadius", () => {
  test("lists corners clockwise from the top left", () => {
    expect(
      cornerRadiiBorderRadius({ topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 }),
    ).toBe("1.000cqw 2.000cqw 3.000cqw 4.000cqw");
  });
});

describe("deviceScreenClipPath with per-corner radii", () => {
  const clipPath = deviceScreenClipPath(
    { topLeft: 2, topRight: 12, bottomRight: 12, bottomLeft: 2 },
    false,
  );

  test("starts and ends on the small top-left corner", () => {
    expect(clipPath).toStartWith("shape(from 2.000cqw -0.5px");
    expect(clipPath).toContain("curve to 2.000cqw -0.5px");
  });

  test("uses the large radius on the right edge", () => {
    expect(clipPath).toContain("hline to calc(100% - 12.000cqw)");
    expect(clipPath).toContain("vline to calc(100% - 12.000cqw + 0.5px)");
  });

  test("uses the small radius on the left edge", () => {
    expect(clipPath).toContain("hline to 2.000cqw");
    expect(clipPath).toContain("vline to calc(2.000cqw - 0.5px)");
  });

  test("draws square corners when a radius is zero", () => {
    const square = deviceScreenClipPath(0, true);

    expect(square).toStartWith("shape(from 0.000cqw -0.5px");
    expect(square).toContain("with 0.000cqw 0 from start / 0 -0.000cqw from end");
  });
});
