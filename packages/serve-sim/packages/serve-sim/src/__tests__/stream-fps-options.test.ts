import { describe, expect, test } from "bun:test";
import { streamFpsOptions } from "../client/utils/stream-fps-options";

const values = (options: { value: string }[]) => options.map((option) => option.value);

describe("streamFpsOptions", () => {
  test("offers no frame rates above 60 by default, as the MJPEG menu uses it", () => {
    expect(values(streamFpsOptions(30))).toEqual(["60", "30", "20", "15", "10", "5"]);
  });

  test("offers 120 when the caller raises the limit, as the video menu does", () => {
    expect(values(streamFpsOptions(60, 120))).toEqual(["120", "60", "30", "20", "15", "10", "5"]);
  });

  test("keeps a custom value at or below the limit selectable", () => {
    expect(values(streamFpsOptions(24, 120))).toEqual(["24", "120", "60", "30", "20", "15", "10", "5"]);
    expect(values(streamFpsOptions(24))).toEqual(["24", "60", "30", "20", "15", "10", "5"]);
  });

  test("does not add an externally configured value above the limit as an option", () => {
    expect(values(streamFpsOptions(140, 120)).every((value) => Number(value) <= 120)).toBe(true);
    expect(values(streamFpsOptions(120)).every((value) => Number(value) <= 60)).toBe(true);
  });
});
