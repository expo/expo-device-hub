import { describe, expect, test } from "bun:test";
import { buildDeleteArgs } from "../simctl-remove";

describe("buildDeleteArgs", () => {
  test("builds the delete command for a udid", () => {
    expect(buildDeleteArgs("ABCDEF01-2345-6789-ABCD-EF0123456789")).toEqual([
      "delete",
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
    ]);
  });
});
