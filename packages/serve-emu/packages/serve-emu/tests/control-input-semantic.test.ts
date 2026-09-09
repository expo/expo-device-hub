import { describe, expect, test } from "bun:test";
import {
  ControlInputQueue,
  ControlInputRejectedError,
  type ControlSemanticDispatcher,
} from "../src/control-input-queue.ts";
import { androidKeyGestureToKeyboardEvents } from "../src/grpc-session.ts";
import type { Gesture } from "../src/input.ts";

describe("ControlInputQueue semantic dispatcher", () => {
  test("serializes gestures and video resets through one FIFO", async () => {
    const events: string[] = [];
    const dispatcher: ControlSemanticDispatcher = {
      async dispatchGesture(gesture) {
        events.push(`gesture:${gesture.type}`);
      },
      async resetVideo() {
        events.push("reset");
      },
    };
    const queue = new ControlInputQueue({ dispatcher });
    const screen = { width: 576, height: 1280 };

    const tap = queue.enqueue({ type: "tap", x: 0.5, y: 0.5 }, screen);
    const reset = queue.enqueueVideoReset();
    const home = queue.enqueue({ type: "home" }, screen);

    await Promise.all([tap.completion, reset.completion, home.completion]);
    expect(events).toEqual(["gesture:tap", "reset", "gesture:home"]);
  });

  test("coalesces adjacent pointer moves before dispatch", async () => {
    const gestures: Gesture[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatcher: ControlSemanticDispatcher = {
      async dispatchGesture(gesture) {
        if (gesture.type === "touch" && gesture.action === "down") {
          await gate;
        }
        gestures.push(gesture);
      },
      async resetVideo() {},
    };
    const queue = new ControlInputQueue({ dispatcher });
    const screen = { width: 576, height: 1280 };

    const down = queue.enqueue(
      { type: "touch", action: "down", x: 0.1, y: 0.1 },
      screen,
    );
    await Promise.resolve();
    const first = queue.enqueue(
      { type: "touch", action: "move", x: 0.2, y: 0.2 },
      screen,
    );
    const second = queue.enqueue(
      { type: "touch", action: "move", x: 0.8, y: 0.8 },
      screen,
    );
    release();

    const completions = await Promise.all([
      down.completion,
      first.completion,
      second.completion,
    ]);
    expect(completions.map((value) => value.status)).toEqual([
      "completed",
      "coalesced",
      "completed",
    ]);
    expect(gestures).toEqual([
      { type: "touch", action: "down", x: 0.1, y: 0.1 },
      { type: "touch", action: "move", x: 0.8, y: 0.8 },
    ]);
  });

  test("coalesces adjacent video resets", async () => {
    let resets = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture() {
          await gate;
        },
        async resetVideo() {
          resets++;
        },
      },
    });
    const active = queue.enqueue(
      { type: "tap", x: 0.5, y: 0.5 },
      { width: 100, height: 100 },
    );
    await Promise.resolve();
    const first = queue.enqueueVideoReset();
    const second = queue.enqueueVideoReset();
    release();

    const [, firstResult, secondResult] = await Promise.all([
      active.completion,
      first.completion,
      second.completion,
    ]);
    expect(firstResult.status).toBe("coalesced");
    expect(secondResult.status).toBe("completed");
    expect(resets).toBe(1);
  });

  test("keeps processing after a source rejects one unsupported gesture", async () => {
    const events: string[] = [];
    const queue = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture) {
          if (gesture.type === "key") {
            androidKeyGestureToKeyboardEvents(gesture);
          }
          events.push(gesture.type);
        },
        async resetVideo() {},
      },
    });
    const screen = { width: 576, height: 1280 };

    const unsupported = queue.enqueue(
      { type: "key", keycode: 82 },
      screen,
    );
    const tap = queue.enqueue({ type: "tap", x: 0.5, y: 0.5 }, screen);

    const rejection = await unsupported.completion.catch((error) => error);
    expect(rejection).toBeInstanceOf(ControlInputRejectedError);
    await expect(tap.completion).resolves.toEqual({ status: "completed" });
    expect(events).toEqual(["tap"]);
    expect(queue.snapshot().closed).toBe(false);
  });
});
