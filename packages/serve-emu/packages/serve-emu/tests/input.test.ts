import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
  MAX_TEXT_BYTES,
  dispatch,
  normalizeTextForControl,
  parseGesture,
  type Gesture,
} from "../src/input.ts";

class FakeSocket {
  readonly writes: Buffer[] = [];

  write(chunk: Uint8Array | string): boolean {
    this.writes.push(Buffer.from(chunk));
    return true;
  }
}

function parsedText(text: string): Extract<Gesture, { type: "text" }> {
  const gesture = parseGesture({ type: "text", text });
  if (gesture.type !== "text") throw new Error("expected a text gesture");
  return gesture;
}

function decodeTextPacket(packet: Buffer): string {
  expect(packet.readUInt8(0)).toBe(1);
  const length = packet.readUInt32BE(1);
  expect(packet.length).toBe(5 + length);
  return packet.subarray(5).toString("utf8");
}

async function dispatchText(gesture: Extract<Gesture, { type: "text" }>) {
  const socket = new FakeSocket();
  await dispatch(socket as unknown as Socket, gesture, { width: 1080, height: 1920 });
  expect(socket.writes).toHaveLength(1);
  return socket.writes[0];
}

async function expectParsedPacketParity(input: string, expected: string) {
  const gesture = parsedText(input);
  expect(gesture.text).toBe(expected);
  expect(Buffer.byteLength(gesture.text, "utf8")).toBeLessThanOrEqual(MAX_TEXT_BYTES);

  const packet = await dispatchText(gesture);
  expect(packet.readUInt32BE(1)).toBe(Buffer.byteLength(gesture.text, "utf8"));
  expect(decodeTextPacket(packet)).toBe(gesture.text);
}

describe("normalizeTextForControl", () => {
  test("preserves ASCII and empty text", () => {
    expect(normalizeTextForControl("hello")).toBe("hello");
    expect(normalizeTextForControl("")).toBe("");
  });

  test("truncates overlong ASCII to the byte limit", () => {
    const normalized = normalizeTextForControl("a".repeat(MAX_TEXT_BYTES + 1));
    expect(normalized).toBe("a".repeat(MAX_TEXT_BYTES));
    expect(Buffer.byteLength(normalized, "utf8")).toBe(MAX_TEXT_BYTES);
  });

  test("keeps a multibyte code point that exactly fits", () => {
    const normalized = normalizeTextForControl(`${"a".repeat(298)}éZ`);
    expect(normalized).toBe(`${"a".repeat(298)}é`);
    expect(Buffer.byteLength(normalized, "utf8")).toBe(MAX_TEXT_BYTES);
  });

  test("never splits an emoji code point at the boundary", () => {
    const normalized = normalizeTextForControl(`${"a".repeat(298)}😀`);
    expect(normalized).toBe("a".repeat(298));
    expect(Buffer.byteLength(normalized, "utf8")).toBe(298);
    expect(Buffer.from(normalized, "utf8").toString("utf8")).toBe(normalized);
  });

  test("canonicalizes lone surrogates to the bytes scrcpy receives", async () => {
    const input = `before\ud800after`;
    const expected = "before�after";

    expect(normalizeTextForControl(input)).toBe(expected);
    await expectParsedPacketParity(input, expected);
  });
});

describe("text control packet parity", () => {
  test("parsed and packet text match for empty and ASCII input", async () => {
    await expectParsedPacketParity("", "");
    await expectParsedPacketParity("plain text", "plain text");
    await expectParsedPacketParity("x".repeat(301), "x".repeat(MAX_TEXT_BYTES));
  });

  test("parsed and packet text match at multibyte and emoji boundaries", async () => {
    await expectParsedPacketParity(
      `${"a".repeat(298)}étail`,
      `${"a".repeat(298)}é`,
    );
    await expectParsedPacketParity(
      `${"a".repeat(296)}😀tail`,
      `${"a".repeat(296)}😀`,
    );
    await expectParsedPacketParity(
      `${"a".repeat(298)}😀tail`,
      "a".repeat(298),
    );
  });

  test("dispatch normalizes callers that bypass parseGesture", async () => {
    const input = `${"한".repeat(100)}😀extra`;
    const expected = "한".repeat(100);
    const packet = await dispatchText({ type: "text", text: input });

    expect(decodeTextPacket(packet)).toBe(expected);
    expect(packet.readUInt32BE(1)).toBe(MAX_TEXT_BYTES);
  });
});
