import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { createApp, type CreateAppDependencies, type EmuApp } from "../src/middleware.ts";
import type { ExecResult, execText } from "../src/exec.ts";
import { SHAKE_ACCELERATION, SHAKE_EMULATOR_ONLY_MESSAGE, shakeEmulator } from "../src/shake.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

// No test here reaches adb: emulator serials use an injected shake, and the default shake
// refuses a physical serial before it runs a command.
async function startApp(serial: string, dependencies: CreateAppDependencies = {}): Promise<EmuApp> {
  const controls = new ControlInputQueue({ writer: { async write() {} } });
  let end!: (value: null) => void;
  const frames = new Promise<null>((resolve) => {
    end = resolve;
  });
  return createApp(
    { serial },
    {
      readOrientation: readNoOrientation,
      startSession: async () => ({
        serial,
        mode: "scrcpy",
        inputSource: "scrcpy",
        meta: { deviceName: "test", codecId: "h264", width: 576, height: 1280 },
        controls,
        readFrame: () => frames,
        onFatal: () => () => {},
        async close() {
          controls.close();
          end(null);
        },
      }),
      ...dependencies,
    },
  );
}

function request(path: string, method = "GET"): Request {
  return new Request(`http://router.test${path}`, { method });
}

function post(path: string, body: unknown): Request {
  return new Request(`http://router.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An emulator console that records `sensor set acceleration` values and rests at 0:9.8:0. */
function fakeConsole() {
  const written: string[] = [];
  const ok = (stdout: string): ExecResult<string> => ({
    status: 0,
    stdout,
    stderr: "",
    signal: null,
    timedOut: false,
    error: null,
  });
  const runExec = (async (_cmd: string, args: string[]) => {
    if (args.includes("get")) return ok("acceleration = 0:9.8:0\r\nOK\r\n");
    written.push(args.at(-1)!);
    return ok("OK\r\n");
  }) as unknown as typeof execText;
  return { written, runExec };
}

describe("middleware shake", () => {
  test("a tap during a shake replays after it, and overlapping shakes record once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shaken: string[] = [];
    const app = await startApp("emulator-5608", {
      shake: async (serial) => {
        shaken.push(serial);
        await gate;
      },
    });
    try {
      const first = app.handleRequest(post("/api/shake", {}));
      const second = app.handleRequest(post("/api/shake", {}));
      while (shaken.length === 0) await Bun.sleep(1);
      const tap = await app.handleRequest(post("/api/tap", { x: 0.5, y: 0.5 }));
      expect(tap.status).toBe(200);
      release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);

      expect(shaken).toHaveLength(1);
      const session = (await (await app.handleRequest(request("/api/session"))).json()) as {
        events: Array<{ kind: string }>;
      };
      expect(session.events.map((event) => event.kind)).toEqual(["shake", "gesture"]);
    } finally {
      await app.stop();
    }
  });

  test("an oversized shake body gets 413 and does not shake", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5610", {
      shake: async (serial) => {
        shaken.push(serial);
      },
    });
    try {
      const response = await app.handleRequest(post("/api/shake", { pad: "x".repeat(1100) }));
      expect(response.status).toBe(413);
      expect(shaken).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("records a shake unless asked not to, and a replay shakes again", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5604", {
      shake: async (serial) => {
        shaken.push(serial);
      },
    });
    try {
      expect((await app.handleRequest(post("/api/shake", {}))).status).toBe(200);
      expect((await app.handleRequest(post("/api/shake", { record: false }))).status).toBe(200);
      const invalid = await app.handleRequest(post("/api/shake", { record: "no" }));
      expect(invalid.status).toBe(400);
      expect(shaken).toHaveLength(2);

      const session = (await (await app.handleRequest(request("/api/session"))).json()) as {
        events: unknown[];
      };
      expect(session.events).toMatchObject([{ kind: "shake", source: "rest:shake" }]);

      expect((await app.handleRequest(post("/api/session/replay", {}))).status).toBe(200);
      while (shaken.length < 3) await Bun.sleep(1);
      expect(shaken).toEqual(["emulator-5604", "emulator-5604", "emulator-5604"]);
    } finally {
      await app.stop();
    }
  });

  test("stop waits until a running shake restores the resting acceleration", async () => {
    const { written, runExec } = fakeConsole();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await startApp("emulator-5600", {
      shake: (serial) => shakeEmulator(serial, runExec, () => gate),
    });
    const response = app.handleRequest(request("/api/shake", "POST"));
    while (written.length === 0) await Bun.sleep(1);

    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(written).toEqual([`${SHAKE_ACCELERATION}:9.8:0`]);

    release();
    await stopping;
    expect(written).toEqual([`${SHAKE_ACCELERATION}:9.8:0`, "0:9.8:0"]);
    await response;
  });

  test("advertises shake for an emulator and shakes it", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5598", {
      shake: async (serial) => {
        shaken.push(serial);
      },
    });
    try {
      const info = await app.handleRequest(request("/api"));
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(true);

      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(shaken).toEqual(["emulator-5598"]);

      const wrongMethod = await app.handleRequest(request("/api/shake"));
      expect(wrongMethod.status).toBe(405);
      expect(shaken).toHaveLength(1);
    } finally {
      await app.stop();
    }
  });

  test("reports a failed shake as a structured error", async () => {
    const app = await startApp("emulator-5598", {
      shake: async () => {
        throw new Error("Emulator acceleration write failed: KO: console gone");
      },
    });
    try {
      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Emulator acceleration write failed: KO: console gone",
      });
    } finally {
      await app.stop();
    }
  });

  test("does not advertise or shake a physical device", async () => {
    const app = await startApp("R58M123ABC");
    try {
      const info = await app.handleRequest(request("/api"));
      expect(((await info.json()) as { shake?: unknown }).shake).toBe(false);

      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: SHAKE_EMULATOR_ONLY_MESSAGE });
    } finally {
      await app.stop();
    }
  });
});
