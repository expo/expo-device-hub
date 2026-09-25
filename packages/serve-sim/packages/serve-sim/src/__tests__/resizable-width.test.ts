import { describe, expect, test } from "bun:test";
import { resizedValue } from "../client/hooks/use-resizable-width";

describe("resizedValue", () => {
  test("keeps the grabbed edge under the pointer for a centered panel", () => {
    expect(resizedValue(720, 1_000, 1_050, 360, 1_400, "center-right")).toBe(820);
    expect(resizedValue(720, 1_000, 950, 360, 1_400, "center-right")).toBe(620);
  });

  test("clamps centered panel resizing to its width limits", () => {
    expect(resizedValue(720, 1_000, 2_000, 360, 1_400, "center-right")).toBe(1_400);
    expect(resizedValue(720, 1_000, 0, 360, 1_400, "center-right")).toBe(360);
  });

  test("preserves anchored panel resize directions", () => {
    expect(resizedValue(400, 100, 125, 200, 800, "right")).toBe(425);
    expect(resizedValue(400, 100, 125, 200, 800, "left")).toBe(375);
    expect(resizedValue(400, 100, 75, 200, 800, "up")).toBe(425);
  });
});
