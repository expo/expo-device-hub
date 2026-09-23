import { describe, expect, test } from "bun:test";
import { shouldStreamSimulatorLogs } from "../client/utils/simulator-logs";

describe("simulator log streaming", () => {
  test("is off unless the URL opts in", () => {
    for (const hostname of ["localhost", "127.0.0.1", "serve-sim.example.com"]) {
      expect(shouldStreamSimulatorLogs({ hostname, search: "" })).toBe(false);
    }
  });

  test("opts in with logs=1", () => {
    expect(
      shouldStreamSimulatorLogs({
        hostname: "localhost",
        search: "?device=DEVICE-A&logs=1",
      })
    ).toBe(true);
  });

  test("ignores other values", () => {
    expect(shouldStreamSimulatorLogs({ hostname: "localhost", search: "?logs=0" })).toBe(false);
    expect(shouldStreamSimulatorLogs({ hostname: "localhost", search: "?logs=true" })).toBe(false);
  });
});
