import { expect, test } from "bun:test";

import { gpuWarningFrom } from "../useEmulatorGpuWarning";

const SOFTWARE = { renderer: "Google SwiftShader", name: "SwiftShader", software: true };
const HARDWARE = {
  renderer: "Android Emulator OpenGL ES Translator (Apple M2)",
  name: "Apple M2",
  software: false,
};

test("warns about a software renderer on a host with a usable GPU", () => {
  expect(gpuWarningFrom({ gpuAvailable: true, renderer: SOFTWARE })).toEqual({
    renderer: "SwiftShader",
  });
});

test.each([
  ["a GPU renderer", { gpuAvailable: true, renderer: HARDWARE }],
  ["a host without a usable GPU", { gpuAvailable: false, renderer: SOFTWARE }],
  ["an unknown renderer", { gpuAvailable: true, renderer: null }],
  ["a renderer without a name", { gpuAvailable: true, renderer: { ...SOFTWARE, name: "" } }],
  ["an error body", { error: "Expected ?serial=emulator-<port>" }],
  ["no body", null],
])("does not warn for %s", (_case, body) => {
  expect(gpuWarningFrom(body)).toBeNull();
});
