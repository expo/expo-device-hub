import { describe, expect, test } from "bun:test";
import { shouldStreamSimulatorLogs } from "../client/utils/simulator-logs";

describe("simulator log streaming", () => {
  test("defaults to enabled for loopback previews", () => {
    for (const hostname of [
      "localhost",
      "preview.localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "0.0.0.0",
    ]) {
      expect(shouldStreamSimulatorLogs({ hostname, search: "" })).toBe(true);
    }
  });

  test("defaults to disabled for remote previews", () => {
    for (const hostname of [
      "session.eas-simulator.ngrok.dev",
      "serve-sim.example.com",
      "192.168.1.20",
    ]) {
      expect(shouldStreamSimulatorLogs({ hostname, search: "" })).toBe(false);
    }
  });

  test("allows remote previews to opt in explicitly", () => {
    expect(shouldStreamSimulatorLogs({
      hostname: "session.eas-simulator.ngrok.dev",
      search: "?device=DEVICE-A&logs=1",
    })).toBe(true);
  });

  test("allows local previews to opt out explicitly", () => {
    expect(shouldStreamSimulatorLogs({
      hostname: "localhost",
      search: "?logs=0",
    })).toBe(false);
  });

  test("does not enable remote logs for other values", () => {
    expect(shouldStreamSimulatorLogs({
      hostname: "session.eas-simulator.ngrok.dev",
      search: "?logs=true",
    })).toBe(false);
  });
});
