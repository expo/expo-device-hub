import { describe, expect, test } from "bun:test";
import {
  compileGesture,
  type Gesture,
  type Screen,
} from "../src/input.ts";

const SCREEN: Screen = { width: 1080, height: 1920 };

function packetHex(gesture: Gesture): string[] {
  const compiled = compileGesture(gesture, SCREEN);
  expect(compiled.bytes).toBe(
    compiled.steps.reduce((total, step) => total + step.packet.length, 0),
  );
  return compiled.steps.map((step) => step.packet.toString("hex"));
}

describe("scrcpy control packet golden bytes", () => {
  test("tap encodes an atomic down/up sequence", () => {
    const gesture: Gesture = { type: "tap", x: 0.25, y: 0.5 };
    const compiled = compileGesture(gesture, SCREEN);

    expect(compiled.gesture).toEqual(gesture);
    expect(compiled.steps.map((step) => step.delayMs)).toEqual([0, 20]);
    expect(compiled.steps.map((step) => step.packet.toString("hex"))).toEqual([
      "020000000000000000000000010e000003c004380780ffff0000000100000001",
      "020100000000000000000000010e000003c00438078000000000000100000000",
    ]);
    expect(compiled.bytes).toBe(64);
  });

  test("swipe encodes every timed interpolation packet in order", () => {
    const gesture: Gesture = {
      type: "swipe",
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      durationMs: 80,
    };
    const compiled = compileGesture(gesture, SCREEN);

    expect(compiled.gesture).toEqual(gesture);
    expect(compiled.steps.map((step) => step.delayMs)).toEqual([
      0,
      10,
      10,
      10,
      10,
      10,
      10,
      10,
      10,
    ]);
    expect(compiled.steps.map((step) => step.packet.toString("hex"))).toEqual([
      "02000000000000000000000000000000000004380780ffff0000000100000001",
      "0202000000000000000000000087000000f004380780ffff0000000100000001",
      "020200000000000000000000010e000001e004380780ffff0000000100000001",
      "0202000000000000000000000195000002d004380780ffff0000000100000001",
      "020200000000000000000000021c000003c004380780ffff0000000100000001",
      "02020000000000000000000002a3000004b004380780ffff0000000100000001",
      "020200000000000000000000032a000005a004380780ffff0000000100000001",
      "02020000000000000000000003b10000069004380780ffff0000000100000001",
      "0201000000000000000000000438000007800438078000000000000100000000",
    ]);
    expect(compiled.bytes).toBe(9 * 32);
  });

  test("key press encodes down/up with its meta state", () => {
    const gesture: Gesture = { type: "key", keycode: 66, metaState: 65 };
    const compiled = compileGesture(gesture, SCREEN);

    expect(compiled.gesture).toEqual(gesture);
    expect(compiled.steps.map((step) => step.delayMs)).toEqual([0, 0]);
    expect(packetHex(gesture)).toEqual([
      "0000000000420000000000000041",
      "0001000000420000000000000041",
    ]);
    expect(compiled.bytes).toBe(28);
  });

  test("explicit key actions emit exactly one packet", () => {
    expect(packetHex({ type: "key", keycode: 20, action: "down" })).toEqual([
      "0000000000140000000000000000",
    ]);
    expect(packetHex({ type: "key", keycode: 20, action: "up" })).toEqual([
      "0001000000140000000000000000",
    ]);
  });

  test("text encodes its UTF-8 byte length", () => {
    const gesture: Gesture = { type: "text", text: "testé" };
    const compiled = compileGesture(gesture, SCREEN);

    expect(compiled.gesture).toEqual(gesture);
    expect(compiled.steps.map((step) => step.delayMs)).toEqual([0]);
    expect(packetHex(gesture)).toEqual(["010000000674657374c3a9"]);
    expect(compiled.bytes).toBe(11);
  });

  const namedKeys: Array<{
    name: "back" | "home" | "recents" | "power";
    packets: string[];
  }> = [
    { name: "back", packets: ["0400", "0401"] },
    {
      name: "home",
      packets: [
        "0000000000030000000000000000",
        "0001000000030000000000000000",
      ],
    },
    {
      name: "recents",
      packets: [
        "0000000000bb0000000000000000",
        "0001000000bb0000000000000000",
      ],
    },
    {
      name: "power",
      packets: [
        "00000000001a0000000000000000",
        "00010000001a0000000000000000",
      ],
    },
  ];

  for (const { name, packets } of namedKeys) {
    test(`${name} encodes the expected press`, () => {
      const gesture: Gesture = { type: name };
      const compiled = compileGesture(gesture, SCREEN);

      expect(compiled.gesture).toEqual(gesture);
      expect(compiled.steps.map((step) => step.delayMs)).toEqual([0, 0]);
      expect(packetHex(gesture)).toEqual(packets);
      expect(compiled.bytes).toBe(
        packets.reduce((total, packet) => total + packet.length / 2, 0),
      );
    });
  }
});

describe("text normalization", () => {
  test("preserves an exact 300-byte UTF-8 prefix", () => {
    const text = `${"a".repeat(298)}é`;
    const compiled = compileGesture({ type: "text", text }, SCREEN);

    expect(Buffer.byteLength(text, "utf8")).toBe(300);
    expect(compiled.gesture).toEqual({ type: "text", text });
    expect(compiled.steps).toHaveLength(1);
    expect(compiled.steps[0]!.packet.readUInt32BE(1)).toBe(300);
    expect(compiled.steps[0]!.packet.subarray(5).toString("utf8")).toBe(text);
    expect(compiled.bytes).toBe(305);
  });

  test("truncates only at a complete code-point boundary", () => {
    const text = `${"a".repeat(299)}étrailing`;
    const expected = "a".repeat(299);
    const compiled = compileGesture({ type: "text", text }, SCREEN);

    expect(compiled.gesture).toEqual({ type: "text", text: expected });
    expect(compiled.steps).toHaveLength(1);
    expect(compiled.steps[0]!.packet.readUInt32BE(1)).toBe(299);
    expect(compiled.steps[0]!.packet.subarray(5).toString("utf8")).toBe(
      expected,
    );
    expect(compiled.bytes).toBe(304);
  });

  test("keeps exactly 75 four-byte characters", () => {
    const expected = "😀".repeat(75);
    const compiled = compileGesture(
      { type: "text", text: `${expected}😀` },
      SCREEN,
    );

    expect(Buffer.byteLength(expected, "utf8")).toBe(300);
    expect(compiled.gesture).toEqual({ type: "text", text: expected });
    expect(compiled.steps[0]!.packet.readUInt32BE(1)).toBe(300);
    expect(compiled.steps[0]!.packet.subarray(5).toString("utf8")).toBe(
      expected,
    );
  });
});
