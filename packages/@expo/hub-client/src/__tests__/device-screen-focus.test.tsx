import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeyboardCapture } from "../KeyboardCapture";
import { DeviceScreen } from "../DeviceScreen";
import { type ScrollSample, type TouchSample, type MultiTouchSample } from "../types";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root;
let container: HTMLDivElement;
let surface: HTMLDivElement;
let dom: Window;
let scrolls: ScrollSample[];
let frames: Map<number, FrameRequestCallback>;

beforeEach(async () => {
  dom = new Window();
  scrolls = [];
  frames = new Map();
  let nextFrame = 0;
  stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubGlobal("window", dom);
  stubGlobal("document", dom.document);
  stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  container = element as unknown as HTMLDivElement;
  root = createRoot(container as unknown as HTMLDivElement);
  await act(async () =>
    root.render(
      <DeviceScreen
        client={{ ...NOOP_DEVICE_CLIENT, sendScroll: (sample) => scrolls.push(sample) }}
      />,
    ),
  );
  surface = container.querySelector('[role="application"]') as unknown as HTMLDivElement;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 }) as DOMRect;
});

afterEach(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  restoreGlobals();
});

function wheel(dx: number, dy: number) {
  const event = new dom.WheelEvent("wheel", { deltaX: dx, deltaY: dy, cancelable: true });
  Object.defineProperties(event, { clientX: { value: 50 }, clientY: { value: 100 } });
  surface.dispatchEvent(event as unknown as WheelEvent);
}

function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(0));
}

for (const event of ["blur", "pagehide"]) {
  test(`${event} must cancel the pending wheel frame`, async () => {
    wheel(0, 2);
    wheel(0, 4);
    expect(scrolls).toHaveLength(1);
    expect(frames.size).toBe(1);
    await act(async () => dom.dispatchEvent(new dom.Event(event)));
    // Execute any frame that survived cancellation, as a browser can after window blur.
    frame();
    expect(scrolls).toHaveLength(1);
    expect(frames.size).toBe(0);
    wheel(0, 8);
    expect(scrolls).toHaveLength(2);
    expect(scrolls[1]?.dy).toBeCloseTo(0.04);
  });
}

test("KeyboardCapture restores focus without ending the captured phone gesture", async () => {
  const touches: { phase: string }[] = [];
  let cancellations = 0;
  Object.defineProperty(dom, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(dom, "visualViewport", { configurable: true, value: { height: 400 } });
  await act(async () =>
    root.render(
      <>
        <DeviceScreen
          client={{
            ...NOOP_DEVICE_CLIENT,
            cancelInput: () => {
              cancellations++;
            },
            sendTouch: (sample) => touches.push(sample),
          }}
        />
        <KeyboardCapture open onKeys={() => {}} />
      </>,
    ),
  );
  surface = container.querySelector('[role="application"]')!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 }) as DOMRect;
  Object.assign(surface, { setPointerCapture() {}, releasePointerCapture() {} });
  const input = container.querySelector("input")!;
  expect(document.activeElement).toBe(input);
  const pointer = (type: string, x: number, pointerId = 1) =>
    new dom.PointerEvent(type, {
      bubbles: true,
      pointerId,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: 60,
    });
  await act(async () =>
    surface.dispatchEvent(pointer("pointerdown", 20) as unknown as PointerEvent),
  );
  expect(document.activeElement).toBe(surface);
  await act(async () => {
    frame();
    frame();
  });
  expect(document.activeElement).toBe(input);
  expect(cancellations).toBe(0);
  expect(touches.map((sample) => sample.phase)).toEqual(["begin"]);
  await act(async () => {
    surface.dispatchEvent(pointer("pointermove", 40) as unknown as PointerEvent);
    frame();
  });
  await act(async () => surface.dispatchEvent(pointer("pointerup", 50) as unknown as PointerEvent));
  expect(touches.map((sample) => sample.phase)).toEqual(["begin", "move", "end"]);
});

async function gestureHarness(captureFails = false) {
  const touches: TouchSample[] = [];
  const multi: MultiTouchSample[] = [];
  let cancellations = 0;
  await act(async () =>
    root.render(
      <DeviceScreen
        client={{
          ...NOOP_DEVICE_CLIENT,
          sendTouch: (sample) => touches.push(sample),
          sendMultiTouch: (sample) => multi.push(sample),
          cancelInput: () => {
            cancellations++;
          },
        }}
      />,
    ),
  );
  surface = container.querySelector('[role="application"]')!;
  surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 200 }) as DOMRect;
  const pointer = (type: string, x = 20, pointerId = 1) =>
    new dom.PointerEvent(type, {
      bubbles: true,
      pointerId,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: 60,
    });
  Object.assign(surface, {
    setPointerCapture() {
      if (captureFails) throw new Error("capture unavailable");
    },
    releasePointerCapture(pointerId: number) {
      surface.dispatchEvent(
        pointer("lostpointercapture", 20, pointerId) as unknown as PointerEvent,
      );
    },
  });
  const dispatch = async (type: string, x = 20, pointerId = 1) =>
    act(async () => {
      surface.dispatchEvent(pointer(type, x, pointerId) as unknown as PointerEvent);
    });
  return { touches, multi, dispatch, cancellations: () => cancellations };
}

test("failed capture ends an uncaptured drag on local blur", async () => {
  const s = await gestureHarness(true);
  await s.dispatch("pointerdown");
  await s.dispatch("pointermove", 40);
  const button = dom.document.createElement("button");
  dom.document.body.append(button);
  await act(async () => button.focus());
  frame();
  expect(s.touches).toEqual([
    { phase: "begin", x: 0.2, y: 0.3 },
    { phase: "end", x: 0.4, y: 0.3 },
  ]);
  expect(frames.size).toBe(0);
  await s.dispatch("pointerup", 50);
  expect(s.touches).toHaveLength(2);
});

for (const event of ["lostpointercapture", "pointercancel"]) {
  test(`${event} ends the gesture once and cancels its pending movement`, async () => {
    const s = await gestureHarness();
    await s.dispatch("pointerdown");
    await s.dispatch("pointermove", 40);
    await s.dispatch(event);
    frame();
    expect(s.touches.map((sample) => sample.phase)).toEqual(["begin", "end"]);
    expect(frames.size).toBe(0);
    await s.dispatch("pointerup", 50);
    expect(s.touches).toHaveLength(2);
  });
}

test("normal pointerup ignores synchronous capture loss and uses the real release position", async () => {
  const s = await gestureHarness();
  await s.dispatch("pointerdown");
  await s.dispatch("pointermove", 40);
  await s.dispatch("pointerup", 50);
  expect(s.cancellations()).toBe(0);
  expect(s.touches).toEqual([
    { phase: "begin", x: 0.2, y: 0.3 },
    { phase: "end", x: 0.5, y: 0.3 },
  ]);
  expect(frames.size).toBe(0);
});

test("an uncaptured pointer leaving the surface ends the drag without needing a focus change", async () => {
  const s = await gestureHarness(true);
  await s.dispatch("pointerdown");
  await s.dispatch("pointermove", 40);
  // React derives pointerleave from the bubbling native pointerout event.
  await s.dispatch("pointerout", 120);
  frame();
  expect(s.touches.map((sample) => sample.phase)).toEqual(["begin", "end"]);
  expect(document.activeElement).toBe(surface);
  expect(frames.size).toBe(0);
});

for (const deliveredMove of [false, true]) {
  test(`pinch transition ends at the last forwarded ${deliveredMove ? "move" : "begin"}, not the discarded move`, async () => {
    const s = await gestureHarness();
    await s.dispatch("pointerdown", 20);
    if (deliveredMove) {
      await s.dispatch("pointermove", 60);
      await act(async () => frame());
    }
    await s.dispatch("pointermove", 80);
    await s.dispatch("pointerdown", 40, 2);
    expect(s.touches.at(-1)).toEqual({
      phase: "end",
      x: deliveredMove ? 0.6 : 0.2,
      y: 0.3,
      cancelled: true,
    });
    expect(s.multi).toEqual([{ phase: "begin", a: { x: 0.8, y: 0.3 }, b: { x: 0.4, y: 0.3 } }]);
    const beforeFrame = s.touches.length;
    await act(async () => frame());
    expect(s.touches).toHaveLength(beforeFrame);
    expect(frames.size).toBe(0);
    await s.dispatch("pointerup", 40, 2);
    expect(s.multi.map((sample) => sample.phase)).toEqual(["begin", "end"]);
  });
}
