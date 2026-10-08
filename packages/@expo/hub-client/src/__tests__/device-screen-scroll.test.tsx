import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { DeviceScreen } from "../DeviceScreen";
import { type ScrollSample } from "../types";
import { NOOP_DEVICE_CLIENT } from "../useNoopDeviceClient";
import { createGlobalStubs } from "./test-globals";

const { stubGlobal, restoreGlobals } = createGlobalStubs();
let root: Root;
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
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
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

test("a wheel burst starts immediately and preserves both axes in one update per frame", () => {
  wheel(1, 2);
  wheel(3, 4);
  wheel(-1, 6);
  expect(scrolls).toEqual([{ dx: 0.01, dy: 0.01, x: 0.5, y: 0.5 }]);
  frame();
  expect(scrolls[1]?.dx).toBeCloseTo(0.02);
  expect(scrolls[1]?.dy).toBeCloseTo(0.05);
  expect(scrolls[1]).toMatchObject({ x: 0.5, y: 0.5 });
  wheel(0, 2);
  expect(scrolls).toHaveLength(2);
  frame();
  expect(scrolls).toHaveLength(3);
});

test("starting a touch cancels buffered wheel input before it can restart scrolling", async () => {
  wheel(0, 2);
  wheel(0, 4);
  await act(async () =>
    surface.dispatchEvent(
      new dom.PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 50,
        clientY: 100,
      }) as unknown as PointerEvent,
    ),
  );
  frame();
  expect(scrolls).toHaveLength(1);
});

test("unmount cancels pending wheel frames", async () => {
  wheel(0, 2);
  wheel(0, 4);
  await act(async () => root.unmount());
  expect(frames.size).toBe(0);
  frame();
  expect(scrolls).toHaveLength(1);
});
