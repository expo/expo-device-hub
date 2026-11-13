import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import type { Gesture } from "../src/input.ts";
import { createApp, type EmuApp } from "../src/middleware.ts";
import { startServer } from "../src/server.ts";
import type { SessionAction, SessionSnapshot } from "../src/session-recorder.ts";
import type { EmuSession } from "../src/stream-session.ts";
import type { StreamSocket } from "../src/stream-socket.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

const fixtureDir = process.env.SERVE_EMU_SESSION_EVENTS_TEST_DIR;
const SERIAL = "emulator-5554";
// A 1×1 PNG, so the screenshot route has real image bytes to return.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// An adb that keeps settings, the night mode, the display density, and the hinge angle in a
// state file, and answers every other command with success.
const FAKE_ADB = `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const file = join(dirname(import.meta.path), "state.json");
const state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const save = () => writeFileSync(file, JSON.stringify(state));
let args = Bun.argv.slice(2);
if (args[0] === "-s") args = args.slice(2);
const command = args.join(" ");
if (command === "exec-out screencap -p") {
  process.stdout.write(Buffer.from("${PNG_BASE64}", "base64"));
} else if (args[0] === "shell" && args[1] === "settings" && args[2] === "put") {
  state[args[3] + "/" + args[4]] = args[5];
  save();
} else if (args[0] === "shell" && args[1] === "settings" && args[2] === "get") {
  console.log(state[args[3] + "/" + args[4]] ?? "1");
} else if (command.startsWith("shell cmd uimode night")) {
  if (args.length === 5) {
    state.night = args[4];
    save();
  } else console.log("Night mode: " + (state.night ?? "no"));
} else if (command === "shell wm density") {
  console.log("Physical density: 440");
  if (state.density) console.log("Override density: " + state.density);
} else if (command.startsWith("shell wm density ")) {
  state.density = args[3] === "reset" ? undefined : args[3];
  save();
} else if (command === "shell wm size") {
  console.log("Physical size: 1080x2400");
} else if (command === "emu sensor get hinge-angle0") {
  console.log("hinge-angle0 = " + (state.hinge ?? 180));
} else if (command === "emu fold" || command === "emu unfold") {
  state.hinge = command === "emu fold" ? 0 : 180;
  save();
  console.log("OK");
}
`;

if (!fixtureDir) {
  // Bun resolves bare executable names using its startup PATH. Isolate the ADB
  // fixture in a child test process so other tests never inherit its PATH.
  test("session events subprocess", async () => {
    const dir = await mkdtemp(join(tmpdir(), "serve-emu-session-events-"));
    try {
      await writeFile(join(dir, "adb"), FAKE_ADB, { mode: 0o755 });
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
  }, 60_000);
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

  function fakeSession() {
    const sent: Gesture[] = [];
    const controls = new ControlInputQueue({
      dispatcher: {
        async dispatchGesture(gesture: Gesture) {
          sent.push(gesture);
        },
        async resetVideo() {},
      },
    });
    let end!: (value: null) => void;
    const frames = new Promise<null>((resolve) => {
      end = resolve;
    });
    const session: EmuSession = {
      serial: SERIAL,
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
    };
    return { session, sent, controls };
  }

  const applyRotation = async (_serial: string, mode: string) => ({
    mode: mode === "auto" ? ("free" as const) : ("lock" as const),
    rotation: mode === "auto" ? null : 1,
    orientation: mode === "auto" ? ("auto" as const) : ("landscape" as const),
    pose: mode === "auto" ? null : ("landscape_left" as const),
    raw: "",
  });

  const ROUTE = {
    waypoints: [
      { latitude: 52.3676, longitude: 4.9041 },
      { latitude: 52.52, longitude: 13.405 },
    ],
    speedKph: 1,
    intervalMs: 60_000,
    loop: true,
  };

  function multipart(path: string, field: string, filename: string): Request {
    const boundary = "session-events";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      Buffer.from("bytes"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return new Request(`http://device.test${path}`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
  }

  function json(path: string, body?: unknown, method = "POST"): Request {
    return new Request(`http://device.test${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  type ActionCase = {
    request: () => Request;
    source: string;
    action: SessionAction;
    /** The Appearance route is `/api/uimode` on the middleware and `/api/night-mode` standalone. */
    only?: "middleware" | "standalone";
  };

  /**
   * Every route that records an action, in an order that the fake device accepts. Add a row for
   * each new route that changes or captures the device (LLP 0025).
   */
  const ACTION_CASES: ActionCase[] = [
    {
      request: () => json("/api/screenshot"),
      source: "rest:screenshot",
      action: { type: "screenshot" },
    },
    {
      request: () => json("/api/orientation", { orientation: "landscape" }),
      source: "rest:orientation",
      action: { type: "orientation", orientation: "landscape" },
    },
    {
      request: () => json("/api/fold", { posture: "closed" }),
      source: "rest:fold",
      action: { type: "fold", posture: "closed" },
    },
    {
      request: () => json("/api/uimode", { night: "yes" }),
      source: "rest:uimode",
      action: { type: "setting", setting: "night-mode", value: "dark" },
      only: "middleware",
    },
    {
      request: () => json("/api/night-mode", { mode: "dark" }),
      source: "rest:night-mode",
      action: { type: "setting", setting: "night-mode", value: "dark" },
      only: "standalone",
    },
    {
      request: () => json("/api/font-scale", { scale: 1.3 }),
      source: "rest:font-scale",
      action: { type: "setting", setting: "font-scale", value: 1.3 },
    },
    {
      request: () => json("/api/display-density", { scale: 1.25 }),
      source: "rest:display-density",
      action: { type: "setting", setting: "display-density", value: 1.25 },
    },
    ...(
      [
        ["network", false],
        ["reduce-motion", true],
        ["high-text-contrast", true],
        ["font-weight", true],
        ["software-keyboard", false],
      ] as const
    ).map(
      ([setting, value]): ActionCase => ({
        request: () => json(`/api/${setting}`, { enabled: value }),
        source: `rest:${setting}`,
        action: { type: "setting", setting, value },
      }),
    ),
    {
      request: () => multipart("/api/apps/install", "apk", "demo.apk"),
      source: "rest:apps/install",
      action: { type: "app", action: "install" },
    },
    {
      request: () => multipart("/api/files/import", "file", "photo.png"),
      source: "rest:files/import",
      action: { type: "file-import" },
    },
    ...(["launch", "clear", "force-stop", "reset-permissions"] as const).map(
      (action): ActionCase => ({
        request: () => json(`/api/apps/${action}`, { packageName: "com.example.app" }),
        source: `rest:apps/${action}`,
        action: { type: "app", action, packageName: "com.example.app" },
      }),
    ),
    ...(["grant", "revoke"] as const).map(
      (action): ActionCase => ({
        request: () =>
          json(`/api/apps/${action}`, {
            packageName: "com.example.app",
            permission: "android.permission.CAMERA",
          }),
        source: `rest:apps/${action}`,
        action: {
          type: "app",
          action,
          packageName: "com.example.app",
          permission: "android.permission.CAMERA",
        },
      }),
    ),
    {
      request: () => json("/api/route", ROUTE),
      source: "rest:route",
      action: { type: "route", action: "start" },
    },
    ...(["pause", "resume"] as const).map(
      (action): ActionCase => ({
        request: () => json("/api/route/control", { action }),
        source: "rest:route/control",
        action: { type: "route", action },
      }),
    ),
    {
      request: () => json("/api/route", undefined, "DELETE"),
      source: "rest:route",
      action: { type: "route", action: "stop" },
    },
  ];

  /** Send each request, and expect exactly its action as the newest entry. */
  async function expectEveryActionRecorded(
    target: "middleware" | "standalone",
    send: (request: Request) => Promise<Response>,
    events: () => Promise<SessionSnapshot["events"]>,
  ) {
    for (const entry of ACTION_CASES) {
      if (entry.only && entry.only !== target) continue;
      const before = (await events()).length;
      const request = entry.request();
      const response = await send(request);
      const label = `${target} ${request.method} ${new URL(request.url).pathname}`;
      expect(response.status, `${label}: ${await response.clone().text()}`).toBeLessThan(300);
      const after = await events();
      expect(after.length, label).toBe(before + 1);
      expect(after.at(-1), label).toMatchObject({
        kind: "action",
        replay: false,
        source: entry.source,
        action: entry.action,
      });
    }
  }

  describe("middleware session events", () => {
    let app: EmuApp;
    let sent: Gesture[];
    let queue: ControlInputQueue;

    beforeEach(async () => {
      await rm(join(fixtureDir, "state.json"), { force: true });
      const fake = fakeSession();
      sent = fake.sent;
      queue = fake.controls;
      app = await createApp(
        { serial: SERIAL, streamMode: "grpc-screenshot", inputSource: "grpc" },
        {
          startSession: async () => fake.session,
          clock: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
          readOrientation: readNoOrientation,
          applyRotation,
          setLocation: async () => {},
        },
      );
    });

    afterEach(async () => {
      await app?.stop();
    });

    const send = (request: Request) => app.handleRequest(request);
    const session = async (): Promise<SessionSnapshot> =>
      (await send(new Request("http://device.test/api/session"))).json();

    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (queue.snapshot().depth === 0) return;
      }
      throw new Error("input queue did not drain");
    };

    test("every device action route records its action", async () => {
      await expectEveryActionRecorded("middleware", send, async () => (await session()).events);
    });

    test("a rejected request records nothing", async () => {
      expect((await send(json("/api/orientation", { orientation: "sideways" }))).status).toBe(400);
      expect((await send(json("/api/font-scale", { scale: 9 }))).status).toBe(400);
      expect((await send(json("/api/apps/launch", { packageName: "" }))).status).toBe(400);
      expect((await send(json("/api/route/control", { action: "rewind" }))).status).toBe(400);
      expect((await session()).events).toEqual([]);
    });

    test("Reload's `record: false` key is activity that replay skips", async () => {
      expect((await send(json("/api/tap", { x: 0.25, y: 0.5 }))).status).toBe(200);
      const viewer = new Viewer();
      app.attachWebSocket(viewer, { video: false, frameMeta: false });
      // The Hub preview's Reload button.
      viewer.receive({ type: "key", keycode: 46, record: false });
      await settle();
      expect((await send(json("/api/screenshot"))).status).toBe(200);

      const recorded = await session();
      expect(recorded.events.map((event) => [event.source, event.kind, event.replay])).toEqual([
        ["rest:tap", "gesture", undefined],
        ["ws", "gesture", false],
        ["rest:screenshot", "action", false],
      ]);
      expect(recorded.events[1]).toMatchObject({ gesture: { type: "key", keycode: 46 } });

      sent.length = 0;
      expect((await send(json("/api/session/replay", { multiplier: 100 }))).status).toBe(200);
      for (let i = 0; i < 100 && (await session()).replaying; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect((await session()).replayStatus).toBe("completed");
      // Only the tap is sent again: no reload and no new screenshot.
      expect(sent.map((gesture) => gesture.type)).toEqual(["tap"]);
      expect((await session()).events).toHaveLength(3);
    });

    test("reads and viewer plumbing add no entries", async () => {
      await send(new Request("http://device.test/api"));
      await send(new Request("http://device.test/health"));
      await send(new Request("http://device.test/api/orientation"));
      await send(new Request("http://device.test/api/font-scale"));
      const viewer = new Viewer();
      app.attachWebSocket(viewer, { video: false, frameMeta: false });
      viewer.receive({ type: "reset-video" });
      expect((await session()).events).toEqual([]);
    });
  });

  describe("standalone server session events", () => {
    test("every device action route records its action", async () => {
      await rm(join(fixtureDir, "state.json"), { force: true });
      const fake = fakeSession();
      type Fetch = (request: Request, server: unknown) => Promise<Response>;
      let fetch: Fetch | null = null;
      const started = await startServer(
        { serial: SERIAL, port: 3300 },
        {
          readOrientation: readNoOrientation,
          openSession: async () => fake.session,
          applyRotation,
          setLocation: async () => {},
          serve: ((options: { fetch: Fetch }) => {
            fetch = options.fetch;
            return { port: 3300, stop() {} };
          }) as unknown as typeof Bun.serve,
        },
      );
      try {
        const send = (request: Request) => {
          if (!fetch) throw new Error("server fetch handler was not captured");
          return fetch(request, { upgrade: () => false });
        };
        await expectEveryActionRecorded("standalone", send, async () => {
          const response = await send(new Request("http://device.test/api/session/export"));
          return ((await response.json()) as { events: SessionSnapshot["events"] }).events;
        });
      } finally {
        await started.stop();
      }
    });
  });
}
