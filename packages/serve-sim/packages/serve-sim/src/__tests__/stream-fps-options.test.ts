import { describe, expect, test } from "bun:test";
import { streamFpsOptions } from "../client/utils/stream-fps-options";

describe("streamFpsOptions", () => {
  test("offers no frame rates above 120", () => {
    expect(streamFpsOptions(60).map((option) => option.value)).toEqual([
      "120",
      "60",
      "30",
      "20",
      "15",
      "10",
      "5",
    ]);
  });

  test("keeps a custom value at or below 120 selectable", () => {
    expect(streamFpsOptions(24).map((option) => option.value)).toEqual([
      "24",
      "120",
      "60",
      "30",
      "20",
      "15",
      "10",
      "5",
    ]);
  });

  test("does not add an externally configured high value as an option", () => {
    expect(streamFpsOptions(140).every((option) => Number(option.value) <= 120)).toBe(true);
  });
});
