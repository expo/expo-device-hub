import { describe, expect, test } from "bun:test";
import { buildBootArgs, isAlreadyBootedError } from "../simctl-boot";

describe("buildBootArgs", () => {
  test("builds the boot command for a udid", () => {
    expect(buildBootArgs("ABCDEF01-2345-6789-ABCD-EF0123456789")).toEqual([
      "boot",
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
    ]);
  });
});

describe("isAlreadyBootedError", () => {
  test("matches simctl's already-booted message", () => {
    expect(isAlreadyBootedError("Unable to boot device in current state: Booted")).toBe(true);
  });

  test("is case-insensitive and tolerates spacing", () => {
    expect(isAlreadyBootedError("current state:Booted")).toBe(true);
    expect(isAlreadyBootedError("CURRENT STATE:  BOOTED")).toBe(true);
  });

  test("does not match other failures", () => {
    expect(isAlreadyBootedError("")).toBe(false);
    expect(isAlreadyBootedError("Invalid device: nope")).toBe(false);
    expect(isAlreadyBootedError("current state: Shutdown")).toBe(false);
  });
});
