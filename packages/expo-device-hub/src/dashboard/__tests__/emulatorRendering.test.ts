import { expect, test } from "bun:test";

import { renderingFrom } from "../useEmulatorRendering";

const SOFTWARE = { renderer: "Google SwiftShader", name: "SwiftShader", software: true };
const HARDWARE = {
  renderer: "Android Emulator OpenGL ES Translator (Apple M2)",
  name: "Apple M2",
  software: false,
};

test("reads CPU rendering from a software renderer on a host with a usable GPU", () => {
  expect(renderingFrom({ gpuAvailable: true, renderer: SOFTWARE })).toBe("cpu");
});

test("reads GPU rendering from a hardware renderer on a host with a usable GPU", () => {
  expect(renderingFrom({ gpuAvailable: true, renderer: HARDWARE })).toBe("gpu");
});

test.each([
  ["a host without a usable GPU", { gpuAvailable: false, renderer: null }],
  [
    "a host without a usable GPU, even with a renderer",
    { gpuAvailable: false, renderer: SOFTWARE },
  ],
  ["an unknown renderer", { gpuAvailable: true, renderer: null }],
  ["a renderer without the software flag", { gpuAvailable: true, renderer: { name: "x" } }],
  ["an error body", { error: "Expected ?serial=emulator-<port>" }],
  ["no body", null],
])("reads nothing for %s", (_case, body) => {
  expect(renderingFrom(body)).toBeNull();
});
