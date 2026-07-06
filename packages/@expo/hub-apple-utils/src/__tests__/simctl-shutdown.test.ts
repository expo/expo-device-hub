import { describe, expect, test } from "bun:test";
import { buildShutdownArgs, isAlreadyShutdownError } from "../simctl-shutdown";

describe("buildShutdownArgs", () => {
  test("builds the shutdown command for a udid", () => {
    expect(buildShutdownArgs("ABCDEF01-2345-6789-ABCD-EF0123456789")).toEqual([
      "shutdown",
      "ABCDEF01-2345-6789-ABCD-EF0123456789",
    ]);
  });
});

describe("isAlreadyShutdownError", () => {
  test("matches simctl's already-shutdown message", () => {
    expect(isAlreadyShutdownError("Unable to shutdown device in current state: Shutdown")).toBe(
      true,
    );
  });

  test("is case-insensitive and tolerates spacing", () => {
    expect(isAlreadyShutdownError("current state:Shutdown")).toBe(true);
    expect(isAlreadyShutdownError("CURRENT STATE:  SHUTDOWN")).toBe(true);
  });

  test("does not match other failures", () => {
    expect(isAlreadyShutdownError("")).toBe(false);
    expect(isAlreadyShutdownError("Invalid device: nope")).toBe(false);
    expect(isAlreadyShutdownError("current state: Booted")).toBe(false);
  });
});
