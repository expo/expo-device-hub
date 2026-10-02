import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DeviceScreen } from "../DeviceScreen.js";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient.js";
import { createGlobalStubs } from "./test-globals.js";
const { stubGlobal, restoreGlobals } = createGlobalStubs();
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  restoreGlobals();
});
async function setup() {
  const listeners = new Map<string, Set<() => void>>(),
    frames = new Map<number, FrameRequestCallback>();
  const surface = {
    focus() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
  };
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", {
    addEventListener(name: string, cb: () => void) {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
    },
    removeEventListener(name: string, cb: () => void) {
      listeners.get(name)?.delete(cb);
    },
  });
  stubGlobal("document", { hidden: false, addEventListener() {}, removeEventListener() {} });
  stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(1, cb);
    return 1;
  });
  stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const touch: unknown[] = [],
    multi: unknown[] = [],
    keys: unknown[] = [];
  const client = {
    ...NOOP_DEVICE_CLIENT,
    status: "streaming" as const,
    screen: { width: 100, height: 200 },
    sendTouch: (sample: unknown) => touch.push(sample),
    sendMultiTouch: (sample: unknown) => multi.push(sample),
    sendKey: (key: unknown) => {
      keys.push(key);
      return true;
    },
  };
  await act(async () => {
    renderer = create(<DeviceScreen client={client} />, { createNodeMock: () => surface });
  });
  const overlay = renderer!.root.findByProps({ role: "application" });
  const pointer = (x: number, y: number, altKey = false) => ({
    pointerId: 1,
    pointerType: "mouse",
    button: 0,
    clientX: x,
    clientY: y,
    altKey,
    shiftKey: false,
    preventDefault() {},
    nativeEvent: {},
  });
  return {
    touch,
    multi,
    keys,
    frames,
    overlay,
    pointer,
    blur: () => listeners.get("blur")?.forEach((cb) => cb()),
    client,
  };
}
test("blur ends a drag and cancels its pending animation frame", async () => {
  const s = await setup();
  await act(async () => s.overlay.props.onPointerDown(s.pointer(10, 20)));
  await act(async () => s.overlay.props.onPointerMove(s.pointer(40, 80)));
  expect(s.frames.size).toBe(1);
  await act(async () => s.blur());
  expect(s.frames.size).toBe(0);
  expect(s.touch).toEqual([
    { phase: "begin", x: 0.1, y: 0.1 },
    { phase: "end", x: 0.4, y: 0.4 },
  ]);
  await act(async () => s.overlay.props.onPointerUp(s.pointer(40, 80)));
  expect(s.touch).toHaveLength(2);
});
test("unmount releases both fingers of an Alt gesture", async () => {
  const s = await setup();
  await act(async () => s.overlay.props.onPointerDown(s.pointer(20, 60, true)));
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(s.multi).toEqual([
    { phase: "begin", a: { x: 0.2, y: 0.3 }, b: { x: 0.8, y: 0.7 } },
    { phase: "end", a: { x: 0.2, y: 0.3 }, b: { x: 0.8, y: 0.7 } },
  ]);
});
test("blur releases held modifiers and forwards browser metadata", async () => {
  const s = await setup();
  await act(async () =>
    s.overlay.props.onKeyDown({
      code: "KeyA",
      key: "A",
      repeat: false,
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      nativeEvent: { isComposing: false },
      preventDefault() {},
    }),
  );
  await act(async () => s.blur());
  expect(s.keys).toEqual([
    {
      phase: "down",
      code: "KeyA",
      key: "A",
      repeat: false,
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    },
    {
      phase: "up",
      code: "KeyA",
      key: "A",
      repeat: false,
      shiftKey: true,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
    },
  ]);
});
