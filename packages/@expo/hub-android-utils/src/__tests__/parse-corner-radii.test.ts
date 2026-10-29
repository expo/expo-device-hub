import { describe, expect, test } from "bun:test";

import { parseCornerRadii } from "../parse-corner-radii";

const corner = (position: string, radius: number) =>
  `RoundedCorner{position=${position}, radius=${radius}, center=Point(0, 0)}`;

/** The relevant part of the `DisplayDeviceInfo` line from a Pixel 9 emulator. */
const dumpsys = (width: number, height: number, corners: string) => `Logical Displays: size=1
  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:1", ${width} x ${height}, modeId 1, density 420, roundedCorners RoundedCorners{[${corners}]}, FLAG_TRUSTED}`;

describe("parseCornerRadii", () => {
  test("converts pixel radii to fractions of the screen width", () => {
    const radii = parseCornerRadii(
      dumpsys(
        1080,
        2424,
        [
          corner("TopLeft", 132),
          corner("TopRight", 132),
          corner("BottomRight", 132),
          corner("BottomLeft", 132),
        ].join(", "),
      ),
    );

    expect(radii?.topLeft).toBeCloseTo(132 / 1080, 6);
    expect(radii?.bottomLeft).toBeCloseTo(132 / 1080, 6);
  });

  test("keeps different radii on their own corners", () => {
    const radii = parseCornerRadii(
      dumpsys(
        1000,
        2000,
        [
          corner("TopLeft", 100),
          corner("TopRight", 120),
          corner("BottomRight", 40),
          corner("BottomLeft", 0),
        ].join(", "),
      ),
    );

    expect(radii).toEqual({ topLeft: 0.1, topRight: 0.12, bottomRight: 0.04, bottomLeft: 0 });
  });

  test("uses the short side when the display reports landscape size", () => {
    const radii = parseCornerRadii(
      dumpsys(
        2424,
        1080,
        ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]
          .map((position) => corner(position, 108))
          .join(", "),
      ),
    );

    expect(radii?.topLeft).toBeCloseTo(0.1, 6);
  });

  test("treats a display with no corners as square on Android 12 and newer", () => {
    const square =
      'Logical Displays: size=1\n  DisplayDeviceInfo{"Built-in Screen": uniqueId="local:1", 1080 x 1920, modeId 1, FLAG_TRUSTED}';

    expect(parseCornerRadii(square, 36)).toEqual({
      topLeft: 0,
      topRight: 0,
      bottomRight: 0,
      bottomLeft: 0,
    });
    expect(parseCornerRadii(square, 31)?.topLeft).toBe(0);
    expect(parseCornerRadii(square, 30)).toBeNull();
    expect(parseCornerRadii(square)).toBeNull();
  });

  test("does not call a partial corner list square", () => {
    expect(parseCornerRadii(dumpsys(1080, 2424, corner("TopLeft", 132)), 36)).toBeNull();
  });

  test("returns null without a full set of corners", () => {
    expect(parseCornerRadii(dumpsys(1080, 2424, corner("TopLeft", 132)))).toBeNull();
    expect(parseCornerRadii("Logical Displays: size=0")).toBeNull();
  });
});
