import { describe, expect, test } from "bun:test";

import {
  type AndroidRenderingAnswer,
  renderingAnswerFrom,
  showsCpuRenderingWarning,
} from "../useAndroidRendering";

const SOFTWARE = { renderer: "Google SwiftShader", name: "SwiftShader", software: true };
const HARDWARE = {
  renderer: "Android Emulator OpenGL ES Translator (Apple M2)",
  name: "Apple M2",
  software: false,
};

describe("renderingAnswerFrom", () => {
  test.each([
    [
      { gpuAvailable: true, renderer: SOFTWARE },
      { gpuAvailable: true, rendering: "cpu" },
    ],
    [
      { gpuAvailable: true, renderer: HARDWARE },
      { gpuAvailable: true, rendering: "gpu" },
    ],
    // Every host reads the renderer; the host's GPU is a separate answer.
    [
      { gpuAvailable: false, renderer: SOFTWARE },
      { gpuAvailable: false, rendering: "cpu" },
    ],
    [
      { gpuAvailable: false, renderer: HARDWARE },
      { gpuAvailable: false, rendering: "gpu" },
    ],
    [
      { gpuAvailable: false, renderer: null },
      { gpuAvailable: false, rendering: "unknown" },
    ],
    [
      { gpuAvailable: true, renderer: { name: "x" } },
      { gpuAvailable: true, rendering: "unknown" },
    ],
  ] as const)("reads %j", (body, answer) => {
    expect(renderingAnswerFrom(body)).toEqual(answer);
  });

  test.each([
    ["an error body", { error: "Not a running Android device of this Hub" }],
    ["no body", null],
  ])("reads nothing from %s", (_case, body) => {
    expect(renderingAnswerFrom(body)).toBeNull();
  });
});

describe("showsCpuRenderingWarning", () => {
  const emulator = { platform: "android", physical: false } as const;
  const answer = (gpuAvailable: boolean, rendering: AndroidRenderingAnswer["rendering"]) => ({
    gpuAvailable,
    rendering,
  });

  test("warns for an emulator on the CPU on a host with a usable GPU", () => {
    expect(showsCpuRenderingWarning(emulator, answer(true, "cpu"))).toBe(true);
  });

  test.each([
    ["a host without a usable GPU", emulator, answer(false, "cpu")],
    ["GPU rendering", emulator, answer(true, "gpu")],
    ["an unknown renderer", emulator, answer(true, "unknown")],
    ["no answer yet", emulator, null],
    ["a physical device", { platform: "android", physical: true } as const, answer(true, "cpu")],
    ["a simulator", { platform: "ios", physical: false } as const, answer(true, "cpu")],
    ["no device", undefined, answer(true, "cpu")],
  ])("does not warn for %s", (_case, device, current) => {
    expect(showsCpuRenderingWarning(device, current)).toBe(false);
  });
});
