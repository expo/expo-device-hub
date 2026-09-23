import { describe, expect, test } from "bun:test";
import { isHingeAngle, parseHingeAngle } from "../hinge-angle";

describe("hinge angles", () => {
  test("parses fold positions and degree values", () => {
    expect(parseHingeAngle("fold")).toBe(0);
    expect(parseHingeAngle("half")).toBe(90);
    expect(parseHingeAngle("unfold")).toBe(180);
    expect(parseHingeAngle("45.5")).toBe(45.5);
  });

  test("rejects invalid and out-of-range input", () => {
    for (const value of ["", "Infinity", "NaN", "-1", "181", "open"]) {
      expect(parseHingeAngle(value)).toBeUndefined();
    }
    for (const value of [null, undefined, "90", NaN, Infinity, -1, 181]) {
      expect(isHingeAngle(value)).toBe(false);
    }
    for (const value of [0, 45.5, 90, 180]) {
      expect(isHingeAngle(value)).toBe(true);
    }
  });
});
