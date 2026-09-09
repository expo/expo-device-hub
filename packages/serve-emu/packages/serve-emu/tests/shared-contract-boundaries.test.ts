import { describe, expect, test } from "bun:test";
import { parseGesture } from "../src/shared/control-contracts.ts";
import {
  isWorkerCommand,
  isWorkerEvent,
  parseWorkerCommand,
  parseWorkerEvent,
} from "../src/shared/worker-contracts.ts";
import {
  isWsClientMessage,
  isWsServerMessage,
  parseWsClientMessage,
  parseWsServerJson,
  parseWsServerMessage,
} from "../src/shared/websocket-contracts.ts";

describe("control contract numeric boundaries", () => {
  test("rejects non-finite coordinates and bounded optional integers", () => {
    expect(() => parseGesture({ type: "tap", x: Number.NaN, y: 0 })).toThrow(
      "x must be a finite number",
    );
    for (const pointerId of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseGesture({ type: "touch", action: "move", x: 0, y: 0, pointerId }),
      ).toThrow("pointerId must be a non-negative safe integer");
    }
    for (const metaState of [-1, 1.5, 0x80000000]) {
      expect(() => parseGesture({ type: "key", keycode: 1, metaState })).toThrow(
        "metaState must be a non-negative 32-bit integer",
      );
    }
  });
});

describe("WebSocket contract rejection boundaries", () => {
  test("rejects non-object messages and invalid recording flags", () => {
    for (const value of [null, [], "{}"] as const) {
      expect(() => parseWsClientMessage(value)).toThrow("must be an object");
      expect(isWsClientMessage(value)).toBe(false);
    }
    expect(() => parseWsClientMessage({ type: "home", record: 1 })).toThrow(
      "record must be a boolean",
    );
  });

  test("validates server JSON, unsupported envelopes, and type guards", () => {
    expect(parseWsServerJson('{"ok":true}')).toEqual({ ok: true });
    expect(() => parseWsServerJson("{")).toThrow(
      "WebSocket server message must be valid JSON",
    );
    expect(() => parseWsServerMessage({ ok: false, error: 1 })).toThrow(
      "unsupported WebSocket server message",
    );
    expect(isWsServerMessage({ ok: false, error: "denied" })).toBe(true);
    expect(isWsServerMessage({ ok: "yes" })).toBe(false);
  });
});

describe("worker contract rejection boundaries", () => {
  test("validates command containers and command-specific fields", () => {
    expect(() => parseWorkerCommand(null)).toThrow("worker command must be an object");
    expect(() =>
      parseWorkerCommand({ type: "init", canvas: {}, url: "" }),
    ).toThrow("url must be a non-empty string");
    expect(() => parseWorkerCommand({ type: "send", text: 1 })).toThrow(
      "send text must be a string",
    );
    expect(() => parseWorkerCommand({ type: "unknown" })).toThrow(
      "unsupported worker command",
    );
    expect(isWorkerCommand({ type: "connect" })).toBe(true);
    expect(isWorkerCommand({ type: "send", text: null })).toBe(false);
  });

  test("validates session dimensions, status, and complete stats", () => {
    expect(() => parseWorkerEvent({ type: "status", status: 1 })).toThrow(
      "worker status must be a string",
    );
    expect(() =>
      parseWorkerEvent({ type: "session", size: { width: 0, height: 1 } }),
    ).toThrow("dimensions must be positive");
    expect(() =>
      parseWorkerEvent({
        type: "stats",
        stats: {
          fps: 1,
          decodeQueue: 0,
          transitMs: null,
          e2eMs: null,
          codec: 1,
          rendered: true,
        },
      }),
    ).toThrow("codec must be a string or null");
    expect(() =>
      parseWorkerEvent({
        type: "stats",
        stats: {
          fps: 1,
          decodeQueue: 0,
          transitMs: null,
          e2eMs: null,
          codec: null,
          rendered: "yes",
        },
      }),
    ).toThrow("rendered must be a boolean");
    expect(() => parseWorkerEvent({ type: "unknown" })).toThrow(
      "unsupported worker event",
    );
    expect(isWorkerEvent({ type: "rendered" })).toBe(true);
    expect(isWorkerEvent([])).toBe(false);
  });
});
