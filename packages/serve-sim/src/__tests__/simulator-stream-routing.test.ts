import { describe, expect, test } from "bun:test";
import { resolveSimulatorStreamRouting } from "../client/simulator/simulator-stream-routing";

describe("simulator stream routing", () => {
  test("does not treat WebRTC with external input as an MJPEG relay", () => {
    expect(resolveSimulatorStreamRouting({
      streamMode: "webrtc",
      avccSupported: true,
      hasExternalInput: true,
      hasExternalFrames: false,
    })).toEqual({
      effectiveStreamMode: "webrtc",
      useWebRtc: true,
      useAvcc: false,
      externalInput: true,
      externalMjpeg: false,
      openDirectControlSocket: false,
      openDirectMjpeg: false,
    });
  });

  test("keeps a direct WebSocket for a standalone WebRTC renderer", () => {
    expect(resolveSimulatorStreamRouting({
      streamMode: "webrtc",
      avccSupported: true,
      hasExternalInput: false,
      hasExternalFrames: false,
    }).openDirectControlSocket).toBe(true);
  });

  test("uses relay watchdogs only for externally supplied MJPEG frames", () => {
    expect(resolveSimulatorStreamRouting({
      streamMode: "mjpeg",
      avccSupported: true,
      hasExternalInput: true,
      hasExternalFrames: true,
    }).externalMjpeg).toBe(true);

    expect(resolveSimulatorStreamRouting({
      streamMode: "avcc",
      avccSupported: true,
      hasExternalInput: true,
      hasExternalFrames: true,
    }).externalMjpeg).toBe(false);
  });

  test("falls back unsupported AVCC rendering to direct MJPEG", () => {
    expect(resolveSimulatorStreamRouting({
      streamMode: "avcc",
      avccSupported: false,
      hasExternalInput: false,
      hasExternalFrames: false,
    })).toMatchObject({
      effectiveStreamMode: "mjpeg",
      openDirectMjpeg: true,
    });
  });
});
