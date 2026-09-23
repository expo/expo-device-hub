import { expect, test } from "bun:test";
import { duoPanelStatus } from "../client/components/duo-panel-streams";

const live = { streaming: true, error: null, failure: null };
const waiting = { streaming: false, error: null, failure: null };

test("a healthy inactive feed does not hide a disconnected displayed panel", () => {
  expect(duoPanelStatus("avcc", 3, { 1: live, 3: waiting })).toEqual({ streaming: false, error: null });
  expect(duoPanelStatus("avcc", 1, { 1: live, 3: waiting })).toEqual({ streaming: true, error: null });
  expect(duoPanelStatus("mjpeg", 1, { 1: waiting, 3: live })).toEqual({ streaming: false, error: null });
});

test("terminal codec failure is visible even when the decoder supplies no error string", () => {
  const failed = { ...live, failure: { kind: "codec" as const, codec: "vp9" as const, sessionId: "inner-session" } };
  const result = duoPanelStatus("webrtc", 3, { 1: live, 3: failed });
  expect(result.streaming).toBe(false);
  expect(result.error).toContain("WebRTC");
  expect(duoPanelStatus("webrtc", 1, { 1: live, 3: failed })).toEqual({ streaming: true, error: null });
});

test("native WebRTC errors reach the selected panel and clear after recovery or HTTP fallback", () => {
  const failed = { ...live, error: "WebRTC signaling failed. Retrying..." };
  expect(duoPanelStatus("webrtc", 3, { 1: live, 3: failed })).toEqual({ streaming: false, error: failed.error });
  expect(duoPanelStatus("webrtc", 3, { 1: live, 3: live })).toEqual({ streaming: true, error: null });
  expect(duoPanelStatus("mjpeg", 3, { 1: live, 3: failed })).toEqual({ streaming: true, error: null });
});
