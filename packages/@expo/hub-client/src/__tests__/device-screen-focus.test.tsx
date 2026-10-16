import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { KeyboardCapture } from "../KeyboardCapture";
import { DeviceScreen } from "../DeviceScreen";
import { type ScrollSample } from "../types";
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
  const pointer = (type: string, x: number) =>
    new dom.PointerEvent(type, {
      bubbles: true,
      pointerId: 1,
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
