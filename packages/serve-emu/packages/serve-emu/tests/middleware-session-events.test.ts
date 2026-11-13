import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";
import { createApp, type EmuApp } from "../src/middleware.ts";
import type { SessionSnapshot } from "../src/session-recorder.ts";
import type { StreamSocket } from "../src/stream-socket.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

const fixtureDir = process.env.SERVE_EMU_SESSION_EVENTS_TEST_DIR;
// A 1×1 PNG, so the screenshot route has real image bytes to return.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

if (!fixtureDir) {
  // Bun resolves bare executable names using its startup PATH. Isolate the ADB
  // fixture in a child test process so other tests never inherit its PATH.
  test("middleware session events subprocess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-emu-session-events-"));
    try {
      await writeFile(
        join(dir, "adb"),
        `#!${process.execPath}
const args = Bun.argv.slice(2).join(" ");
if (args === "-s emulator-test exec-out screencap -p") {
  process.stdout.write(Buffer.from("${PNG_BASE64}", "base64"));
} else if (args === "-s emulator-test shell cmd uimode night yes") {
  // Applied.
} else if (args === "-s emulator-test shell cmd uimode night") {
  console.log("Night mode: yes");
} else {
  console.error("unexpected adb call: " + args);
  process.exit(2);
}
`,
        { mode: 0o755 },
      );
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          SERVE_EMU_SESSION_EVENTS_TEST_DIR: dir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (code !== 0) throw new Error(`session event tests failed:\n${stdout}${stderr}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
} else {
  class Viewer implements StreamSocket {
    readonly bufferedAmount = 0;
    #message: (text: string) => void = () => {};
    send(): void {}
    onMessage(handler: (text: string) => void): void {
      this.#message = handler;
    }
    onClose(): void {}
    close(): void {}
    receive(value: unknown): void {
      this.#message(JSON.stringify(value));
    }
  }

  let app: EmuApp;
  let sent: Gesture[];
  let queue: ControlInputQueue;

  beforeEach(async () => {
    sent = [];
    queue = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture: Gesture) {
          sent.push(gesture);
        },
        async resetVideo() {},
      },
    });
    const controls = queue;
    let end!: (value: null) => void;
    const frames = new Promise<null>((resolve) => {
      end = resolve;
    });
    app = await createApp(
      { serial: "emulator-test", streamMode: "grpc-screenshot", inputSource: "grpc" },
      {
        startSession: async () => ({
          serial: "emulator-test",
          mode: "grpc-screenshot",
          inputSource: "grpc",
          meta: { deviceName: "test", codecId: "h264", width: 576, height: 1280 },
          controls,
          readFrame: () => frames,
          onFatal: () => () => {},
          async close() {
            controls.close();
            end(null);
          },
        }),
        clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
        readOrientation: readNoOrientation,
        applyRotation: async (_serial, mode) => ({
          mode: mode === "auto" ? "free" : "lock",
          rotation: mode === "auto" ? null : 1,
          orientation: mode === "auto" ? "auto" : "landscape",
          pose: mode === "auto" ? null : "landscape_left",
          raw: "",
        }),
      },
    );
  });

  afterEach(async () => {
    await app?.stop();
  });

  const post = (path: string, body?: unknown) =>
    app.handleRequest(
      new Request(`http://hub.test${path}`, {
        method: "POST",
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      }),
    );

  const session = async (): Promise<SessionSnapshot> =>
    (await app.handleRequest(new Request("http://hub.test/api/session"))).json();

  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (queue.snapshot().depth === 0) return;
    }
    throw new Error("input queue did not drain");
  };

  describe("middleware session events", () => {
    test("a screenshot is an action entry", async () => {
      const response = await post("/api/screenshot");
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect((await session()).events).toMatchObject([
        {
          id: 1,
          source: "rest:screenshot",
          kind: "action",
          replay: false,
          action: { type: "screenshot" },
        },
      ]);
    });

    test("a rotation is an action entry, and a rejected one is not", async () => {
      expect((await post("/api/orientation", { orientation: "sideways" })).status).toBe(400);
      expect((await post("/api/orientation", { orientation: "landscape" })).status).toBe(200);
      expect((await session()).events).toMatchObject([
        {
          source: "rest:orientation",
          kind: "action",
          replay: false,
          action: { type: "orientation", orientation: "landscape" },
        },
      ]);
    });

    test("an Appearance change records the applied mode", async () => {
      const response = await post("/api/uimode", { night: "yes" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, night: "yes" });
      expect((await session()).events).toMatchObject([
        {
          source: "rest:uimode",
          kind: "action",
          action: { type: "setting", setting: "night-mode", value: "dark" },
        },
      ]);
    });

    test("Reload's `record: false` key is activity that replay skips", async () => {
      expect((await post("/api/tap", { x: 0.25, y: 0.5 })).status).toBe(200);
      const viewer = new Viewer();
      app.attachWebSocket(viewer, { video: false, frameMeta: false });
      // The Hub preview's Reload button.
      viewer.receive({ type: "key", keycode: 46, record: false });
      await settle();
      expect((await post("/api/screenshot")).status).toBe(200);

      const recorded = await session();
      expect(recorded.events.map((event) => [event.source, event.kind, event.replay])).toEqual([
        ["rest:tap", "gesture", undefined],
        ["ws", "gesture", false],
        ["rest:screenshot", "action", false],
      ]);
      expect(recorded.events[1]).toMatchObject({ gesture: { type: "key", keycode: 46 } });

      sent.length = 0;
      expect((await post("/api/session/replay", { multiplier: 100 })).status).toBe(200);
      for (let i = 0; i < 100 && (await session()).replaying; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect((await session()).replayStatus).toBe("completed");
      // Only the tap is sent again: no reload and no new screenshot.
      expect(sent.map((gesture) => gesture.type)).toEqual(["tap"]);
      expect((await session()).events).toHaveLength(3);
    });

    test("reads and viewer plumbing add no entries", async () => {
      await app.handleRequest(new Request("http://hub.test/api"));
      await app.handleRequest(new Request("http://hub.test/health"));
      await app.handleRequest(new Request("http://hub.test/api/orientation"));
      const viewer = new Viewer();
      app.attachWebSocket(viewer, { video: false, frameMeta: false });
      viewer.receive({ type: "reset-video" });
      expect((await session()).events).toEqual([]);
    });
  });
}
