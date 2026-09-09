import { describe, expect, test } from "bun:test";
import {
  DEFAULT_STREAM_CONTROL_SETTINGS,
  mergeStreamControlSettings,
  mergeStreamEncoderSettings,
  mergeStreamPlaybackSettings,
  normalizeStreamControlSettings,
  parseStreamEncoderSettingsPatch,
  isWebRtcTransportLocked,
  streamControlSettingsFrom,
  streamEncoderSettingsFrom,
  streamEncoderSettingsForTransport,
  type StreamControlSettings,
} from "../stream-settings";

describe("stream settings", () => {
  test("keeps MJPEG at 120 fps while video accepts 140 fps", () => {
    expect(normalizeStreamControlSettings({ mjpegFps: 120, h264Fps: 140 })).toMatchObject({
      mjpegFps: 120,
      h264Fps: 140,
    });
    expect(normalizeStreamControlSettings({ mjpegFps: 121, h264Fps: 141 })).toMatchObject({
      mjpegFps: 120,
      h264Fps: 140,
    });
  });

  test("uses native resolution and clamps untrusted numeric values", () => {
    expect(DEFAULT_STREAM_CONTROL_SETTINGS.maxDimension).toBe(0);
    expect(normalizeStreamControlSettings({
      mjpegFps: 0,
      mjpegQuality: 4,
      maxDimension: -1,
      h264Bitrate: Number.POSITIVE_INFINITY,
      h264Fps: 200,
    })).toMatchObject({
      mjpegFps: 1,
      mjpegQuality: 1,
      maxDimension: 0,
      h264Bitrate: 6_000_000,
      h264Fps: 140,
    });
  });

  test("maps launch settings into runtime controls", () => {
    expect(streamControlSettingsFrom({
      transport: "webrtc",
      codec: "vp9",
      iceServers: [{ urls: ["turn:relay.example.test"] }],
      mjpegFps: 10,
      mjpegQuality: 0.55,
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    })).toMatchObject({
      transport: "webrtc",
      webRtcCodec: "vp9",
      mjpegFps: 10,
      mjpegQuality: 0.55,
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
      iceServers: [{ urls: ["turn:relay.example.test"] }],
    });
  });

  test("merges partial updates and allows ICE servers to be cleared", () => {
    const current = normalizeStreamControlSettings({
      transport: "webrtc",
      iceServers: [{ urls: ["turn:relay.example.test"] }],
    });
    const updated = mergeStreamControlSettings(current, { mjpegFps: 15, iceServers: [] });
    expect(updated.mjpegFps).toBe(15);
    expect(updated.iceServers).toBeUndefined();
  });

  test("preserves fallback ICE servers when an update is malformed", () => {
    const current = normalizeStreamControlSettings({
      transport: "webrtc",
      iceServers: [{ urls: ["turn:relay.example.test"] }],
    });

    expect(mergeStreamControlSettings(current, {
      iceServers: "invalid" as unknown as StreamControlSettings["iceServers"],
    }).iceServers).toBe(current.iceServers);
    expect(mergeStreamControlSettings(current, {
      iceServers: [
        { urls: ["stun:stun.example.test"] },
        { urls: ["https://not-an-ice-server.example.test"] },
      ],
    }).iceServers).toBe(current.iceServers);
  });

  test("preserves viewer playback state and identity for unchanged encoder settings", () => {
    const current = normalizeStreamControlSettings({
      transport: "webrtc",
      webRtcCodec: "vp9",
      iceServers: [{ urls: ["turn:relay.example.test"] }],
    });
    const iceServers = current.iceServers;

    expect(mergeStreamEncoderSettings(current, { h264Fps: current.h264Fps })).toBe(current);

    const updated = mergeStreamEncoderSettings(current, { h264Fps: 30 });
    expect(updated).toMatchObject({ transport: "webrtc", webRtcCodec: "vp9", h264Fps: 30 });
    expect(updated.iceServers).toBe(iceServers);
  });

  test("accepts only non-empty, well-typed encoder setting patches", () => {
    expect(parseStreamEncoderSettingsPatch({ h264Fps: 30 })).toEqual({ h264Fps: 30 });
    expect(parseStreamEncoderSettingsPatch(null)).toBeNull();
    expect(parseStreamEncoderSettingsPatch([])).toBeNull();
    expect(parseStreamEncoderSettingsPatch({})).toBeNull();
    expect(parseStreamEncoderSettingsPatch({ h264Fps: "30" })).toBeNull();
    expect(parseStreamEncoderSettingsPatch({ transport: "webrtc" })).toBeNull();
    expect(parseStreamEncoderSettingsPatch({ typo: 30 })).toBeNull();
  });

  test("locks playback to WebRTC while preserving WebRTC choices", () => {
    const current = normalizeStreamControlSettings({
      transport: "webrtc",
      webRtcCodec: "h264",
    });

    expect(mergeStreamPlaybackSettings(
      current,
      { transport: "http", httpCodec: "mjpeg" },
      true,
    )).toBe(current);
    expect(mergeStreamPlaybackSettings(
      current,
      { webRtcCodec: "vp8" },
      true,
    )).toMatchObject({ transport: "webrtc", webRtcCodec: "vp8" });
  });

  test("recognizes WebRTC launches as transport-locked", () => {
    expect(isWebRtcTransportLocked({ transport: "webrtc", codec: "vp9" })).toBe(true);
    expect(isWebRtcTransportLocked({ transport: "http", codec: "h264" })).toBe(false);
    expect(isWebRtcTransportLocked(undefined)).toBe(false);
  });

  test("accepts only WebRTC encoder controls for WebRTC sessions", () => {
    expect(parseStreamEncoderSettingsPatch({
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    }, "webrtc")).toEqual({
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    });
    expect(parseStreamEncoderSettingsPatch({ mjpegFps: 30 }, "webrtc")).toBeNull();
    expect(parseStreamEncoderSettingsPatch({ mjpegQuality: 0.5 }, "webrtc")).toBeNull();
  });

  test("exposes only settings relevant to the locked transport", () => {
    const settings = normalizeStreamControlSettings({
      mjpegFps: 24,
      mjpegQuality: 0.8,
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    });

    expect(streamEncoderSettingsForTransport(settings, "webrtc")).toEqual({
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    });
    expect(streamEncoderSettingsForTransport(settings, "http")).toEqual(
      streamEncoderSettingsFrom(settings),
    );
  });
});
