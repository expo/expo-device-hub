import { describe, expect, test } from "bun:test";
import { shouldStreamSimulatorLogs } from "../client/utils/simulator-logs";

describe("simulator log streaming", () => {
  test("is off unless the URL opts in", () => {
    expect(shouldStreamSimulatorLogs({ search: "" })).toBe(false);
    expect(shouldStreamSimulatorLogs({ search: "?logs=0" })).toBe(false);
    expect(shouldStreamSimulatorLogs({ search: "?logs=true" })).toBe(false);
  });

  test("opts in with logs=1", () => {
    expect(shouldStreamSimulatorLogs({ search: "?device=DEVICE-A&logs=1" })).toBe(true);
  });
});
