import { describe, expect, test } from "bun:test";
import {
  isGesture,
  parseGesture,
  type Gesture,
} from "../src/shared/control-contracts.ts";
import { parseGesture as parseGestureFromInput } from "../src/input.ts";

function gestureName(gesture: Gesture): string {
  switch (gesture.type) {
    case "tap":
    case "swipe":
    case "touch":
    case "key":
    case "text":
    case "back":
    case "home":
    case "recents":
    case "power":
      return gesture.type;
    default: {
      const exhaustive: never = gesture;
      return exhaustive;
    }
  }
}

describe("control contracts", () => {
  test("parses every gesture variant", () => {
    const inputs: unknown[] = [
      { type: "tap", x: 0.25, y: 0.75 },
      { type: "swipe", x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 320 },
      { type: "touch", action: "move", x: 0.5, y: 0.4, pointerId: 7 },
      { type: "key", keycode: 66, action: "down", metaState: 1 },
      { type: "text", text: "hello" },
      { type: "back" },
      { type: "home" },
      { type: "recents" },
      { type: "power" },
    ];

    expect(inputs.map((value) => gestureName(parseGesture(value)))).toEqual([
      "tap",
      "swipe",
      "touch",
      "key",
      "text",
      "back",
      "home",
      "recents",
      "power",
    ]);
  });

  test("rejects unbounded and malformed fields", () => {
    expect(() => parseGesture({ type: "tap", x: -0.1, y: 0 })).toThrow("between 0 and 1");
    expect(() => parseGesture({ type: "touch", action: "hold", x: 0, y: 0 })).toThrow(
      "down, move, or up",
    );
    expect(() => parseGesture({ type: "key", keycode: 1.5 })).toThrow("integer");
    expect(isGesture({ type: "unknown" })).toBe(false);
  });

  test("input.ts preserves the shared parser API", () => {
    const value = { type: "tap", x: 0.2, y: 0.3 };
    expect(parseGestureFromInput(value)).toEqual(parseGesture(value));
  });
});
