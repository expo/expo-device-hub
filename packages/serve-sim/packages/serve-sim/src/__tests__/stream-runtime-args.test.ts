import { describe, expect, test } from "bun:test";
import {
  parseIceUrlList,
  streamHelperArgs,
  streamRuntimeArgs,
  streamSettingsEqual,
} from "../stream-runtime-args";

describe("parseIceUrlList", () => {
  test("normalizes valid STUN and TURN lists", () => {
    expect(parseIceUrlList(" stun:one.test:3478,stuns:two.test:5349 ", "stun")).toEqual([
      "stun:one.test:3478",
      "stuns:two.test:5349",
    ]);
    expect(parseIceUrlList("turn:one.test:3478,turns:two.test:5349", "turn")).toHaveLength(2);
  });

  test("rejects empty lists and URLs for the wrong protocol", () => {
    expect(() => parseIceUrlList(",", "stun")).toThrow();
    expect(() => parseIceUrlList("https://example.test", "stun")).toThrow();
    expect(() => parseIceUrlList("stun:example.test", "turn")).toThrow();
  });
});

describe("streamRuntimeArgs", () => {
  test("forwards HTTP codec options", () => {
    expect(
      streamRuntimeArgs({
        transport: "http",
        codec: "mjpeg",
      }),
    ).toEqual(["--transport", "http", "--codec", "mjpeg"]);
  });

  test("forwards WebRTC transport, codec, STUN, and TURN options", () => {
    expect(
      streamRuntimeArgs({
        transport: "webrtc",
        codec: "vp8",
        mjpegFps: 10,
        mjpegQuality: 0.55,
        maxDimension: 1280,
        h264Bitrate: 3_000_000,
        h264Fps: 60,
        iceServers: [
          { urls: ["stun:stun.example.com:19302"] },
          {
            urls: ["turn:turn.example.com:3478", "turns:turn.example.com:5349"],
            username: "user",
            credential: "pass",
          },
        ],
      }),
    ).toEqual([
      "--transport",
      "webrtc",
      "--webrtc-codec",
      "vp8",
      "--stun-url",
      "stun:stun.example.com:19302",
      "--turn-url",
      "turn:turn.example.com:3478,turns:turn.example.com:5349",
      "--turn-username",
      "user",
      "--turn-credential",
      "pass",
      "--mjpeg-fps",
      "10",
      "--mjpeg-quality",
      "0.55",
      "--max-dimension",
      "1280",
      "--video-bitrate",
      "3000000",
      "--video-fps",
      "60",
    ]);
  });
});

describe("streamSettingsEqual", () => {
  test("treats missing legacy settings as the default HTTP transport", () => {
    expect(streamSettingsEqual(undefined, { transport: "http" })).toBe(true);
    expect(streamSettingsEqual(
      { codec: "auto", transport: "http" },
      { transport: "http" },
    )).toBe(true);
  });

  test("detects explicit transport and codec changes", () => {
    expect(streamSettingsEqual(
      { transport: "http", codec: "mjpeg" },
      { transport: "webrtc", codec: "vp8" },
    )).toBe(false);
    expect(streamSettingsEqual(
      { transport: "webrtc", codec: "vp8" },
      { transport: "webrtc", codec: "vp9" },
    )).toBe(false);
  });

  test("compares normalized encoder settings", () => {
    expect(streamSettingsEqual(
      { transport: "webrtc", codec: "h264" },
      {
        transport: "webrtc",
        codec: "h264",
        mjpegFps: 60,
        mjpegQuality: 0.7,
        maxDimension: 0,
        h264Bitrate: 6_000_000,
        h264Fps: 60,
      },
    )).toBe(true);
    expect(streamSettingsEqual(
      { transport: "webrtc", codec: "h264", maxDimension: 1280 },
      { transport: "webrtc", codec: "h264", maxDimension: 0 },
    )).toBe(false);
  });
});

describe("streamHelperArgs", () => {
  test("builds the re-exec arguments shared by detach and no-preview modes", () => {
    expect(streamHelperArgs("DEVICE-A", 3100, "127.0.0.1", {
      transport: "webrtc",
      codec: "vp9",
    })).toEqual([
      "DEVICE-A",
      "--port",
      "3100",
      "--host",
      "127.0.0.1",
      "--transport",
      "webrtc",
      "--webrtc-codec",
      "vp9",
    ]);
  });
});
