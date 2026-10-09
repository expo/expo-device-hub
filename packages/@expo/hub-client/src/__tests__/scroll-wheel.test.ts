import { describe, expect, test } from "bun:test";

import { createFrameScrollSender, WHEEL_LINE_HEIGHT_PX, wheelDeltaToPixels } from "../scroll-wheel";
import { createFrameScrollSender as createPreviewScrollSender } from "../../../../serve-sim/packages/serve-sim/src/client/simulator/scroll-wheel";
import { createGlobalStubs } from "./test-globals";

for (const [name, createSender] of [
  ["hub-client", createFrameScrollSender],
  ["preview", createPreviewScrollSender],
] as const) {
  test(`${name}: idle frames, zero-net deltas, and cancellation never replay old scrolling`, () => {
    const { stubGlobal, restoreGlobals } = createGlobalStubs();
    const frames = new Map<number, FrameRequestCallback>();
    const sent: { dx: number; dy: number; x: number; y: number }[] = [];
    let nextFrame = 0;
    stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const tick = () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    };
    const sender = createSender((sample) => sent.push(sample));
    try {
      sender.send({ dx: 0, dy: 1, x: 0.5, y: 0.5 });
      sender.send({ dx: 0, dy: 2, x: 0.2, y: 0.3 });
      sender.send({ dx: 0, dy: -2, x: 0.2, y: 0.3 });
      tick();
      expect(sent).toHaveLength(1);
      sender.send({ dx: 1, dy: 2, x: 0.2, y: 0.3 });
      tick();
      expect(sent[1]).toEqual({ dx: 1, dy: 2, x: 0.2, y: 0.3 });
      tick();
      expect(frames.size).toBe(0);
      sender.send({ dx: 0, dy: 1, x: 0.5, y: 0.5 });
      expect(sent).toHaveLength(3);
      sender.send({ dx: 0, dy: 2, x: 0.5, y: 0.5 });
      sender.cancel();
      tick();
      expect(sent).toHaveLength(3);
      expect(frames.size).toBe(0);
    } finally {
      sender.cancel();
      restoreGlobals();
    }
  });
}

describe("wheelDeltaToPixels", () => {
  test("passes pixel-mode deltas through", () => {
    expect(wheelDeltaToPixels(12.5, 0, 400)).toBe(12.5);
    expect(wheelDeltaToPixels(-3, 0, 400)).toBe(-3);
  });

  test("scales line- and page-mode deltas", () => {
    expect(wheelDeltaToPixels(2, 1, 400)).toBe(2 * WHEEL_LINE_HEIGHT_PX);
    expect(wheelDeltaToPixels(0.5, 2, 400)).toBe(200);
  });

  test("is defensive about bad inputs", () => {
    expect(wheelDeltaToPixels(Number.NaN, 0, 400)).toBe(0);
    // A zero-height axis must not zero out (or NaN) a page-mode delta.
    expect(wheelDeltaToPixels(1, 2, 0)).toBe(1);
  });
});
