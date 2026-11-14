import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  type AndroidRenderingAnswer,
  renderingAnswerFrom,
  readAndroidRendering,
  showsCpuRenderingWarning,
} from "../useAndroidRendering";

const SOFTWARE = {
  renderer: "Google SwiftShader",
  name: "SwiftShader",
  software: true,
};
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

describe("renderer discovery after boot", () => {
  let originalWindow: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { __EXPO_DEVICE_HUB_BASE_PATH__: "/hub" },
    });
  });
  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  test("recovers from a discovery 404 without a stream reconnect", async () => {
    const controller = new AbortController();
    const urls: string[] = [];
    let waits = 0;
    const answer = await readAndroidRendering(
      "emulator-5554",
      controller.signal,
      async (url, options) => {
        urls.push(url);
        expect(options.signal).toBe(controller.signal);
        return urls.length === 1
          ? new Response(null, { status: 404 })
          : Response.json({ gpuAvailable: true, renderer: SOFTWARE });
      },
      async () => {
        waits++;
      },
    );
    expect(answer).toEqual({ gpuAvailable: true, rendering: "cpu" });
    expect(urls).toEqual([
      "/hub/api/devices/gpu?serial=emulator-5554",
      "/hub/api/devices/gpu?serial=emulator-5554",
    ]);
    expect(waits).toBe(1);
  });

  test("bounds discovery retries and keeps an absent device unknown", async () => {
    let calls = 0;
    const answer = await readAndroidRendering(
      "gone",
      new AbortController().signal,
      async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
      async () => {},
    );
    expect(answer).toBeNull();
    expect(calls).toBe(3);
  });

  test("does not retry an authorization refusal", async () => {
    let calls = 0;
    const answer = await readAndroidRendering(
      "other",
      new AbortController().signal,
      async () => {
        calls++;
        return new Response(null, { status: 403 });
      },
      async () => {
        throw new Error("must not retry");
      },
    );
    expect(answer).toBeNull();
    expect(calls).toBe(1);
  });

  test("aborting a real retry wait settles without another request", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = readAndroidRendering("old", controller.signal, async () => {
      calls++;
      return new Response(null, { status: 404 });
    });
    await Promise.resolve();
    controller.abort();
    expect(await pending).toBeNull();
    expect(calls).toBe(1);
  });

  test("a device switch or deadline abort cancels discovery retries", async () => {
    const controller = new AbortController();
    let calls = 0;
    const answer = await readAndroidRendering(
      "old",
      controller.signal,
      async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
      async () => {
        controller.abort();
      },
    );
    expect(answer).toBeNull();
    expect(calls).toBe(1);
  });
});
