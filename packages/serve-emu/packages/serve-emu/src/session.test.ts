import { afterEach, describe, expect, test } from "bun:test";
import {
  backendForStreamMode,
  EMU_STREAM_MODES,
  resolveBackend,
  startSession,
  streamModeForBackend,
} from "./session.ts";

const originalBackend = process.env.SERVE_EMU_BACKEND;

afterEach(() => {
  if (originalBackend === undefined) delete process.env.SERVE_EMU_BACKEND;
  else process.env.SERVE_EMU_BACKEND = originalBackend;
});

describe("stream mode selection", () => {
  test("publishes the supported CLI values", () => {
    expect(EMU_STREAM_MODES).toEqual(["scrcpy", "grpc-screenshot"]);
  });

  test("maps public stream modes to session backends", () => {
    expect(backendForStreamMode("scrcpy")).toBe("scrcpy");
    expect(backendForStreamMode("grpc-screenshot")).toBe("grpc");
    expect(backendForStreamMode("grpc")).toBeUndefined();
    expect(backendForStreamMode(undefined)).toBeUndefined();
    expect(streamModeForBackend("scrcpy")).toBe("scrcpy");
    expect(streamModeForBackend("grpc")).toBe("grpc-screenshot");
  });

  test("keeps the environment variable compatible with both gRPC spellings", () => {
    process.env.SERVE_EMU_BACKEND = "grpc";
    expect(resolveBackend()).toBe("grpc");
    process.env.SERVE_EMU_BACKEND = "grpc-screenshot";
    expect(resolveBackend()).toBe("grpc");
  });

  test("does not silently fall back for a strict gRPC selection", async () => {
    await expect(
      startSession({ serial: "physical-device", backend: "grpc", strictBackend: true }),
    ).rejects.toThrow("grpc-screenshot requires an Android Emulator serial");
  });
});
