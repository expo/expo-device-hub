import { describe, expect, test } from "bun:test";
import { agentLibraryPath } from "../src/paths.mjs";

describe("agent backend selection", () => {
  test("keeps the existing software Linux agent by default", () => {
    expect(agentLibraryPath("linux", {})).toEndWith("/linux-x64/libexpo_emulator_capture.so");
  });
  test("selects the separate NVIDIA agent explicitly", () => {
    expect(agentLibraryPath("linux", { EXPO_EMULATOR_CAPTURE_BACKEND: "nvidia" })).toEndWith(
      "/linux-x64/libexpo_emulator_capture_nvidia.so",
    );
  });
  test("rejects unsupported backends and NVIDIA on Mac", () => {
    expect(() => agentLibraryPath("linux", { EXPO_EMULATOR_CAPTURE_BACKEND: "other" })).toThrow();
    expect(() => agentLibraryPath("darwin", { EXPO_EMULATOR_CAPTURE_BACKEND: "nvidia" })).toThrow();
  });
});
