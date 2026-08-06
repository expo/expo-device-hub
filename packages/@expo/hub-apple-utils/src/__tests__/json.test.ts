import { describe, expect, test } from "bun:test";
import { asString, isRecord, safeJsonParse } from "../json";

describe("safeJsonParse", () => {
  test("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ value: { a: 1 }, error: null });
  });

  test("returns undefined and the malformed JSON error", () => {
    expect(safeJsonParse("{ not json")).toEqual({
      value: undefined,
      error: expect.objectContaining({ message: "[apple-utils] Failed to parse JSON output:" }),
    });
  });
});

describe("isRecord", () => {
  test("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test("rejects arrays, null and primitives", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(7)).toBe(false);
  });
});

describe("asString", () => {
  test("returns strings unchanged", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString("")).toBe("");
  });

  test("returns undefined for non-strings", () => {
    expect(asString(7)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
    expect(asString(undefined)).toBeUndefined();
    expect(asString({})).toBeUndefined();
  });
});
