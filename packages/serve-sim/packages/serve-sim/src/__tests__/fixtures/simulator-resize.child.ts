import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSimulatorResize } from "../../client/hooks/use-simulator-resize";
import { SIMULATOR_RESIZE_SCALE_STORAGE_KEY } from "../../client/utils/simulator-resize";

const storage = new Map<string, string>();
const windowEvents = Object.assign(new EventTarget(), {
  devicePixelRatio: 1,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: windowEvents,
  document: Object.assign(new EventTarget(), { body: { style: {} }, visibilityState: "visible" }),
  requestAnimationFrame: (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  cancelAnimationFrame: clearTimeout,
});
let model: ReturnType<typeof useSimulatorResize>;
let renderer: ReactTestRenderer | undefined;
function Frame({ width, height }: { width: number; height: number }) {
  model = useSimulatorResize({
    defaultWidth: 320,
    viewportWidth: width,
    viewportHeight: height,
    aspectRatio: 2,
    onStart() {},
  });
  return null;
}
async function render(width: number, height = 900) {
  await act(async () => {
    if (renderer) renderer.update(createElement(Frame, { width, height }));
    else renderer = create(createElement(Frame, { width, height }));
  });
}
beforeEach(() => {
  storage.set(SIMULATOR_RESIZE_SCALE_STORAGE_KEY, String(700 / 320));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  storage.clear();
});

test("restores the chosen size after a panel closes", async () => {
  await render(1280);
  expect(model.width).toBe(700);
  await render(508);
  expect(model.width).toBe(460);
  windowEvents.dispatchEvent(new Event("pagehide"));
  expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
  await render(1280);
  expect(model.width).toBe(700);
});

test("restores the saved preference when initially mounted beside a panel", async () => {
  await render(508);
  expect(model.width).toBe(460);
  await render(1280);
  expect(model.width).toBe(700);
});

test("keeps an explicit keyboard resize made beside an open panel", async () => {
  await render(1280);
  await render(508);
  await act(async () =>
    model.onKeyDown({ key: "ArrowLeft", shiftKey: false, preventDefault() {} } as never),
  );
  expect(model.width).toBe(436);
  await render(1280);
  expect(model.width).toBe(436);
  windowEvents.dispatchEvent(new Event("pagehide"));
  expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(436 / 320);
});

test("commits a pointer resize from the visible constrained size", async () => {
  await render(508);
  await act(async () =>
    model.onPointerDown({
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { setPointerCapture() {} },
    } as never),
  );
  await act(async () => {
    model.onPointerMove({
      pointerId: 1,
      clientX: -24,
      clientY: 0,
      preventDefault() {},
      stopPropagation() {},
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(model.width).toBe(436);
  windowEvents.dispatchEvent(new Event("pagehide"));
  expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(436 / 320);
  // A final stationary sample leaves no release momentum.
  await new Promise((resolve) => setTimeout(resolve, 170));
  await act(async () => {
    model.onPointerMove({
      pointerId: 1,
      clientX: -24,
      clientY: 0,
      preventDefault() {},
      stopPropagation() {},
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  await act(async () =>
    model.onPointerEnd({ pointerId: 1, preventDefault() {}, stopPropagation() {} } as never),
  );
  await render(1280);
  expect(model.width).toBe(436);
});

for (const pointerMotion of ["none", "stationary", "out-and-back"] as const) {
  test(`a no-op pointer gesture preserves the preference (${pointerMotion})`, async () => {
    await render(1280);
    await render(508);
    const event = {
      button: 0,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { setPointerCapture() {} },
    };
    await act(async () => model.onPointerDown(event as never));
    expect(model.width).toBe(460);
    if (pointerMotion === "out-and-back") {
      await act(async () => {
        model.onPointerMove({ ...event, clientX: -24 } as never);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    if (pointerMotion !== "none") {
      await act(async () => {
        model.onPointerMove(event as never);
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    windowEvents.dispatchEvent(new Event("pagehide"));
    expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
    await act(async () => model.onPointerEnd(event as never));
    await render(1280);
    expect(model.width).toBe(700);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
  });
}

for (const key of ["ArrowRight", "ArrowDown"]) {
  test(`a height-constrained ${key} preserves the preference at a fractional limit`, async () => {
    await render(1280);
    await render(1280, 315.54);
    expect(model.width).toBeCloseTo(359.08);
    await act(async () => model.onKeyDown({ key, shiftKey: false, preventDefault() {} } as never));
    expect(model.width).toBeCloseTo(359.08);
    windowEvents.dispatchEvent(new Event("pagehide"));
    expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
    await render(1280);
    expect(model.width).toBe(700);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
  });

  test(`a constrained ${key} preserves the saved preference when no size change is possible`, async () => {
    await render(1280);
    await render(508);
    expect(model.width).toBe(460);
    await act(async () => model.onKeyDown({ key, shiftKey: false, preventDefault() {} } as never));
    windowEvents.dispatchEvent(new Event("pagehide"));
    expect(Number(storage.get(SIMULATOR_RESIZE_SCALE_STORAGE_KEY))).toBe(700 / 320);
    await render(1280);
    expect(model.width).toBe(700);
  });
}
