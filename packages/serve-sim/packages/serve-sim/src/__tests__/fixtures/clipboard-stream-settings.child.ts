import { expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as native from "../../native";
import * as ui from "../../ui-settings";
import * as copy from "../../sim-pasteboard-copy";
import type { StreamEncoderSettings, StreamSettings } from "../../stream-settings";
import { UDID } from "../helpers";

const captures: StreamEncoderSettings[] = [];
const keys: Array<{ type: string; usage: number }> = [];
let captureStarts = 0;
class Capture {
  constructor(_udid: string, settings: StreamEncoderSettings) {
    captures.push({ ...settings });
  }
  async start() {
    captureStarts++;
  }
  async stop() {}
  async subscribeScreenChanges() {
    return async () => {};
  }
  async subscribeDeviceState() {
    return async () => {};
  }
  async screenSize() {
    return { width: 390, height: 844, screenId: 0, orientation: "portrait" };
  }
}
class Hid {
  async setScreen() {}
  async supportsHingeAngle() {
    return false;
  }
  async supportsPhysicalOrientation() {
    return false;
  }
  async keyChecked(type: string, usage: number) {
    keys.push({ type, usage });
  }
}
mock.module("../../native", () => ({ ...native, NativeCapture: Capture, NativeHid: Hid }));
mock.module("../../ui-settings", () => ({ ...ui, refreshDeviceOptionState: async () => {} }));
mock.module("../../sim-pasteboard-copy", () => ({
  ...copy,
  copyFromSim: async (
    _udid: string,
    sendShortcut: () => Promise<void>,
    inInputTurn: (copy: () => Promise<string>) => Promise<string>,
  ) => ({
    text: await inInputTurn(async () => {
      await sendShortcut();
      return "selected text";
    }),
  }),
}));
const { simMiddleware } = await import("../../middleware");
const { peekDeviceSession, closeDeviceSession } = await import("../../device-session");

class Socket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  replies: Record<string, unknown>[] = [];
  send(data: string | Buffer) {
    this.replies.push(JSON.parse(String(data)));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  async next(): Promise<Record<string, unknown>> {
    for (let i = 0; i < 200; i++) {
      const reply = this.replies.shift();
      if (reply) return reply;
      await Bun.sleep(5);
    }
    throw new Error("Exec socket did not reply");
  }
}

test.each(["clipboard.copy", "clipboard.paste"])(
  "%s before a viewer keeps WebRTC and the configured encoder",
  async (action) => {
    captures.length = keys.length = captureStarts = 0;
    const streamSettings: StreamSettings = {
      transport: "webrtc",
      codec: "vp8",
      h264Bitrate: 2_300_000,
      h264Fps: 24,
      maxDimension: 720,
    };
    const token = "clipboard-stream-settings-test";
    const middleware = simMiddleware({
      basePath: "/",
      execToken: token,
      streamSettings,
      clipboard: "unmanaged",
      loopbackOnly: true,
    });
    const socket = new Socket();
    try {
      expect(peekDeviceSession(UDID)).toBeUndefined();
      expect(
        middleware.handleWebSocket!(
          new Request("http://localhost/exec-ws", {
            headers: {
              host: "localhost",
              origin: "http://localhost",
              "sec-websocket-protocol": `serve-sim.token.${token}`,
            },
          }),
          socket,
        ),
      ).toBe(true);
      expect(await socket.next()).toEqual({ ready: true });
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            id: 1,
            action,
            params: {
              udid: UDID.toLowerCase(),
              streamSettings: { transport: "http", h264Bitrate: 1_000_000 },
            },
          }),
        ),
      );
      const reply = await socket.next();
      expect(reply).toMatchObject({ id: 1, exitCode: 0, stderr: "" });
      expect(JSON.parse(reply.stdout as string)).toEqual(
        action === "clipboard.copy" ? { text: "selected text" } : { ok: true },
      );
      expect(keys).toContainEqual({
        type: "down",
        usage: action === "clipboard.copy" ? 0x06 : 0x19,
      });
      const session = peekDeviceSession(UDID);
      expect(session).toBeDefined();
      expect(captureStarts).toBe(1);
      expect(captures).toEqual([
        expect.objectContaining({ h264Bitrate: 2_300_000, h264Fps: 24, maxDimension: 720 }),
      ]);

      const settings = await middleware(
        new Request(`http://localhost/helper/${UDID}/stream-settings`, {
          headers: { host: "localhost" },
        }),
      );
      expect(settings?.status).toBe(200);
      expect(await settings!.json()).toEqual({
        h264Bitrate: 2_300_000,
        h264Fps: 24,
        maxDimension: 720,
      });
      const stream = await middleware(
        new Request(`http://localhost/helper/${UDID}/stream.mjpeg`, {
          headers: { host: "localhost" },
        }),
      );
      expect(stream?.status).toBe(409);
      expect(await stream!.json()).toMatchObject({
        error: "stream_transport_locked",
        transport: "webrtc",
      });
      expect(peekDeviceSession(UDID)).toBe(session);
      expect(captureStarts).toBe(1);
    } finally {
      socket.close();
      closeDeviceSession(UDID);
      await middleware.dispose();
    }
  },
);
