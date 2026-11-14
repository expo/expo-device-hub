import { describe, expect, test } from "bun:test";

import { parseAndroidStreamSource, sameAndroidStreamSource } from "../android-stream-source";

describe("parseAndroidStreamSource", () => {
  test.each(["png", "mmap", "rgb888"])(
    "parses the authoritative %s gRPC image mode",
    (grpcImageMode) => {
      expect(
        parseAndroidStreamSource({
          ok: true,
          mode: "grpc-screenshot",
          grpcImageMode,
          encoder: "software",
          encoderName: "libx264",
          availableEncoders: ["software", "hardware"],
          inputSource: "scrcpy",
          availableInputSources: ["scrcpy", "grpc"],
          availableModes: ["scrcpy", "grpc-screenshot"],
          sessionGeneration: 4,
        }),
      ).toEqual({
        mode: "grpc-screenshot",
        grpcImageMode,
        encoder: "software",
        encoderName: "libx264",
        availableEncoders: ["software", "hardware"],
        inputSource: "scrcpy",
        availableInputSources: ["scrcpy", "grpc"],
        availableModes: ["scrcpy", "grpc-screenshot"],
        sessionGeneration: 4,
      });
    },
  );

  test("parses the emulator capture source and the reasons for unavailable sources", () => {
    const response = {
      ok: true,
      mode: "emulator-capture",
      grpcImageMode: "rgb888",
      encoder: "software",
      encoderName: null,
      availableEncoders: ["software"],
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy"],
      availableModes: ["scrcpy", "grpc-screenshot", "emulator-capture"],
      sessionGeneration: 2,
    };
    expect(parseAndroidStreamSource(response)).toMatchObject({
      mode: "emulator-capture",
      availableModes: ["scrcpy", "grpc-screenshot", "emulator-capture"],
    });
    expect(parseAndroidStreamSource(response)).not.toHaveProperty("unavailableModes");

    const withReasons = parseAndroidStreamSource({
      ...response,
      mode: "scrcpy",
      availableModes: ["scrcpy", "grpc-screenshot"],
      // Unknown sources and empty reasons are dropped; the rest of the status stays.
      unavailableModes: {
        "emulator-capture": " Restart the Hub. ",
        "screen-copy": "x",
        scrcpy: "",
      },
    });
    expect(withReasons?.unavailableModes).toEqual({ "emulator-capture": "Restart the Hub." });
  });

  test("rejects missing or unsupported image modes", () => {
    const response = {
      ok: true,
      mode: "grpc-screenshot",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy", "grpc"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 1,
    };
    expect(parseAndroidStreamSource(response)).toBeNull();
    expect(parseAndroidStreamSource({ ...response, grpcImageMode: "rgb" })).toBeNull();
  });

  test("rejects unavailable or unsupported input sources", () => {
    const response = {
      ok: true,
      mode: "grpc-screenshot",
      grpcImageMode: "png",
      encoder: "software",
      encoderName: "libx264",
      availableEncoders: ["software", "hardware"],
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy", "grpc"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      sessionGeneration: 1,
    };
    expect(parseAndroidStreamSource({ ...response, inputSource: "adb" })).toBeNull();
    expect(parseAndroidStreamSource({ ...response, availableInputSources: ["grpc"] })).toBeNull();
  });
});

describe("Android gRPC encoder status", () => {
  const response = {
    ok: true,
    mode: "grpc-screenshot",
    grpcImageMode: "rgb888",
    encoder: "hardware",
    encoderName: "h264_videotoolbox",
    availableEncoders: ["software", "hardware"],
    inputSource: "grpc",
    availableInputSources: ["scrcpy", "grpc"],
    availableModes: ["scrcpy", "grpc-screenshot"],
    sessionGeneration: 5,
  };

  test("reports the resolved encoder and retains probe errors with the current source", () => {
    expect(parseAndroidStreamSource(response)).toMatchObject({
      encoder: "hardware",
      encoderName: "h264_videotoolbox",
      availableEncoders: ["software", "hardware"],
    });
    expect(parseAndroidStreamSource({ ...response, encoderName: null })).toMatchObject({
      encoder: "hardware",
      encoderName: null,
    });
    expect(
      parseAndroidStreamSource({
        ...response,
        encoder: "software",
        encoderName: "libx264",
        availableEncoders: ["software"],
        hardwareEncoderError: "No usable hardware encoder: permission denied.",
      }),
    ).toMatchObject({
      encoder: "software",
      encoderName: "libx264",
      availableEncoders: ["software"],
      hardwareEncoderError: "No usable hardware encoder: permission denied.",
      sessionGeneration: 5,
    });
  });

  test("keeps older software-only hosts readable without advertising hardware support", () => {
    const {
      encoder: _encoder,
      encoderName: _encoderName,
      availableEncoders: _available,
      ...legacy
    } = response;
    expect(parseAndroidStreamSource(legacy)).toMatchObject({
      encoder: "software",
      encoderName: null,
      availableEncoders: ["software"],
    });
  });

  test("rejects invalid encoder fields and malformed availability", () => {
    for (const patch of [
      { encoder: "nvenc" },
      { encoderName: "" },
      { encoderName: 123 },
      { availableEncoders: [] },
      { availableEncoders: ["hardware"] },
      { availableEncoders: ["software", "software"] },
      { availableEncoders: ["software", "nvenc"] },
      { hardwareEncoderError: false },
      { hardwareEncoderError: "" },
    ]) {
      expect(parseAndroidStreamSource({ ...response, ...patch })).toBeNull();
    }
  });
});

test("preserves only finite nonnegative source repeat cadence metadata", () => {
  const source = {
    ok: true,
    mode: "grpc-screenshot",
    grpcImageMode: "mmap",
    inputSource: "scrcpy",
    availableInputSources: ["scrcpy"],
    availableModes: ["scrcpy", "grpc-screenshot"],
    sessionGeneration: 1,
  };
  for (const repeatFrameMs of [0, 500, 30_000]) {
    expect(parseAndroidStreamSource({ ...source, repeatFrameMs })).toMatchObject({ repeatFrameMs });
  }
  for (const repeatFrameMs of [undefined, null, -1, NaN, Infinity, "500", true]) {
    const parsed = parseAndroidStreamSource({ ...source, repeatFrameMs });
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("repeatFrameMs");
  }
});

test("a status with only a new unavailable reason is a change", () => {
  const status = (reason?: string) =>
    parseAndroidStreamSource({
      ok: true,
      mode: "grpc-screenshot",
      grpcImageMode: "mmap",
      inputSource: "scrcpy",
      availableInputSources: ["scrcpy"],
      availableModes: ["scrcpy", "grpc-screenshot"],
      ...(reason ? { unavailableModes: { "emulator-capture": reason } } : {}),
      sessionGeneration: 0,
    })!;
  const installing = status("Installing expo-emulator-capture…");
  expect(sameAndroidStreamSource(installing, status("Installing expo-emulator-capture…"))).toBe(
    true,
  );
  expect(sameAndroidStreamSource(installing, status("npm install failed: offline"))).toBe(false);
  expect(sameAndroidStreamSource(installing, status())).toBe(false);
  expect(sameAndroidStreamSource(null, installing)).toBe(false);
});
