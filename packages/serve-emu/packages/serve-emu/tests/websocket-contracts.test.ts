import { describe, expect, test } from "bun:test";
import {
  isWsClientMessage,
  parseWsClientJson,
  parseWsClientMessage,
  parseWsServerMessage,
  type WsServerMessage,
} from "../src/shared/websocket-contracts.ts";

function serverMessageName(message: WsServerMessage): string {
  if ("type" in message) return message.type;
  return message.ok ? "ack" : "failure";
}

describe("WebSocket contracts", () => {
  test("parses gesture metadata and reset requests", () => {
    expect(
      parseWsClientMessage({ type: "tap", x: 0.5, y: 0.25, ack: false, record: false }),
    ).toEqual({ type: "tap", x: 0.5, y: 0.25, ack: false, record: false });
    expect(parseWsClientMessage({ type: "reset-video", ack: false })).toEqual({
      type: "reset-video",
      ack: false,
    });
  });

  test("validates JSON and option types", () => {
    expect(parseWsClientJson('{"type":"home"}')).toEqual({ type: "home" });
    expect(() => parseWsClientJson("{" )).toThrow("valid JSON");
    expect(() => parseWsClientMessage({ type: "home", ack: "no" })).toThrow("ack must be a boolean");
    expect(isWsClientMessage({ type: "tap", x: 2, y: 0 })).toBe(false);
  });

  test("parses every server text envelope", () => {
    const messages = [
      parseWsServerMessage({ ok: true }),
      parseWsServerMessage({ ok: false, error: "bad gesture" }),
      parseWsServerMessage({ type: "video-session", size: { width: 1080, height: 2400 } }),
    ];
    expect(messages.map(serverMessageName)).toEqual(["ack", "failure", "video-session"]);
    expect(() =>
      parseWsServerMessage({ type: "video-session", size: { width: 0, height: 2400 } }),
    ).toThrow("positive finite");
  });
});
