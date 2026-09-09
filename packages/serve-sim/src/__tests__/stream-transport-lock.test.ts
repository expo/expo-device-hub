import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { DeviceSession } from "../device-session";
import { DEFAULT_STREAM_ENCODER_SETTINGS } from "../stream-settings";

function createWebRtcSession(): DeviceSession {
  // Exercise the real HTTP handlers without constructing simulator-native capture/HID objects.
  const session = Object.create(DeviceSession.prototype) as DeviceSession;
  Object.assign(session, {
    transport: "webrtc",
    encoderSettings: { ...DEFAULT_STREAM_ENCODER_SETTINGS },
    streamSettingsUpdate: Promise.resolve(),
    capture: {
      updateStreamSettings: async () => {},
    },
  });
  return session;
}

describe("WebRTC-locked stream endpoints", () => {
  let server: Server;
  let origin: string;
  let session: DeviceSession;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://serve-sim.test").pathname;
      if (pathname === "/stream.mjpeg") {
        session.handleMjpeg(req, res);
        return;
      }
      if (pathname === "/stream.avcc") {
        session.handleAvcc(req, res);
        return;
      }
      if (pathname === "/stream-settings") {
        void session.handleStreamSettings(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
    origin = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    session = createWebRtcSession();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });

  for (const pathname of ["/stream.mjpeg", "/stream.avcc"]) {
    test(`${pathname} rejects HTTP video for a WebRTC launch`, async () => {
      const response = await fetch(origin + pathname);

      expect(response.status).toBe(409);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(await response.json()).toEqual({
        error: "stream_transport_locked",
        transport: "webrtc",
      });
    });
  }

  test("GET /stream-settings exposes only WebRTC encoder controls", async () => {
    const response = await fetch(origin + "/stream-settings");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      maxDimension: 0,
      h264Bitrate: 6_000_000,
      h264Fps: 60,
    });
  });

  test("PATCH /stream-settings rejects HTTP-only controls and transport changes", async () => {
    for (const body of [{ mjpegFps: 30 }, { mjpegQuality: 0.5 }, { transport: "http" }]) {
      const response = await fetch(origin + "/stream-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_stream_settings" });
    }
  });

  test("PATCH /stream-settings still updates WebRTC encoder controls", async () => {
    const response = await fetch(origin + "/stream-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxDimension: 1280, h264Bitrate: 3_000_000, h264Fps: 30 }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      maxDimension: 1280,
      h264Bitrate: 3_000_000,
      h264Fps: 30,
    });
  });
});
