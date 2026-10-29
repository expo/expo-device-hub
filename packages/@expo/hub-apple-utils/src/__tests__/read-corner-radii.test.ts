import { describe, expect, test } from "bun:test";

import { parseCornerRadii, readCornerRadii } from "../read-corner-radii";

const display = (overrides: Record<string, unknown>) => ({
  displayType: "integrated",
  screenID: 1,
  width: 1206,
  height: 2622,
  scale: 3,
  cornerRadiusUL: 62,
  cornerRadiusUR: 62,
  cornerRadiusLR: 62,
  cornerRadiusLL: 62,
  ...overrides,
});

describe("parseCornerRadii", () => {
  test("divides point radii by the screen width in points", () => {
    const radii = parseCornerRadii({ capabilities: { displays: [display({})] } });

    // iPhone 17 Pro: 62 pt corners on a 402 pt wide screen.
    expect(radii?.topLeft).toBeCloseTo(62 / 402, 6);
    expect(radii?.bottomRight).toBeCloseTo(62 / 402, 6);
  });

  test("keeps iPhone Duo's small corners on the left", () => {
    const radii = parseCornerRadii({
      capabilities: {
        displays: [
          display({
            width: 1398,
            height: 2034,
            cornerRadiusUL: 8,
            cornerRadiusUR: 59,
            cornerRadiusLR: 59,
            cornerRadiusLL: 8,
          }),
          display({ screenID: 3, width: 2007, cornerRadiusUL: 55, cornerRadiusLL: 55 }),
        ],
      },
    });

    expect(radii?.topLeft).toBeCloseTo(8 / 466, 6);
    expect(radii?.bottomLeft).toBeCloseTo(8 / 466, 6);
    expect(radii?.topRight).toBeCloseTo(59 / 466, 6);
    expect(radii?.bottomRight).toBeCloseTo(59 / 466, 6);
  });

  test("keeps square corners at zero", () => {
    const radii = parseCornerRadii({
      capabilities: {
        displays: [
          display({ cornerRadiusUL: 0, cornerRadiusUR: 0, cornerRadiusLR: 0, cornerRadiusLL: 0 }),
        ],
      },
    });

    expect(radii).toEqual({ topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 });
  });

  test("skips displays that are not integrated or are incomplete", () => {
    expect(
      parseCornerRadii({
        capabilities: {
          displays: [
            display({ displayType: "tvOut" }),
            display({ cornerRadiusLL: undefined }),
            display({ scale: 0 }),
          ],
        },
      }),
    ).toBeNull();
  });

  test("returns null for unexpected payloads", () => {
    expect(parseCornerRadii(null)).toBeNull();
    expect(parseCornerRadii({ capabilities: {} })).toBeNull();
    expect(parseCornerRadii({ capabilities: { displays: "none" } })).toBeNull();
  });
});

describe("readCornerRadii", () => {
  test("returns null without a device type identifier", async () => {
    expect(await readCornerRadii(null)).toEqual({ value: null, error: null });
  });

  test("returns null when the device type has no profile", async () => {
    const read = await readCornerRadii(
      "com.apple.CoreSimulator.SimDeviceType.Nope",
      "/nonexistent",
    );

    expect(read.value).toBeNull();
  });
});
