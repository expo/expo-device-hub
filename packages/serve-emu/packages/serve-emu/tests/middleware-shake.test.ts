import { describe, expect, test } from "bun:test";
import { ControlInputQueue } from "../src/control-input-queue.ts";
import { createApp, type CreateAppDependencies, type EmuApp } from "../src/middleware.ts";
import {
  SHAKE_DISTANCE_M,
  SHAKE_EMULATOR_ONLY_MESSAGE,
  shakeEmulator,
  type PhysicalModelClient,
  type ShakeMotion,
} from "../src/shake.ts";
import { readNoOrientation } from "./fixtures/orientation.ts";

// No test here reaches an emulator: emulator serials use an injected shake, and the default
// shake refuses a physical serial before it connects.
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

/** An emulator physical model that records each position and rests at 0,0,0. */
function fakePhysicalModel() {
  const positions: number[][] = [];
  const client: PhysicalModelClient = {
    getPhysicalModel: async () => [0, 0, 0],
    setPhysicalModel: async (_target, data) => {
      positions.push([...data]);
    },
    close() {},
  };
  return { positions, connect: async () => client };
}

/** A shake that starts at once, swings while it is held, and reports how long it swung. */
function holdingShake(shaken: string[]): ShakeMotion {
  return async (serial, control) => {
    shaken.push(serial);
    const start = Date.now();
    control.started?.();
    while (control.keepShaking(Date.now() - start)) await Bun.sleep(2);
    return Date.now() - start;
  };
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
        return 0;
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

  test("a failed shake leaves no event in the session", async () => {
    const app = await startApp("emulator-5616", {
      shake: async () => {
        throw new Error("Emulator shake failed: setPhysicalModel: grpc-status 14");
      },
    });
    try {
      expect((await app.handleRequest(post("/api/shake", {}))).status).toBe(400);
      const session = (await (await app.handleRequest(request("/api/session"))).json()) as {
        events: unknown[];
      };
      expect(session.events).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("an oversized shake body gets 413 and does not shake", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5610", { shake: holdingShake(shaken) });
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
    const app = await startApp("emulator-5604", { shake: holdingShake(shaken) });
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

  test("stop waits until a running shake moves the device back", async () => {
    const { positions, connect } = fakePhysicalModel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = await startApp("emulator-5600", {
      shake: (serial, control) => shakeEmulator(serial, control, { connect, wait: () => gate }),
    });
    const response = app.handleRequest(request("/api/shake", "POST"));
    while (positions.length === 0) await Bun.sleep(1);

    let stopped = false;
    const stopping = app.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(5);
    expect(stopped).toBe(false);
    expect(positions).toEqual([[0, 0, SHAKE_DISTANCE_M]]);

    release();
    await stopping;
    expect(positions).toEqual([
      [0, 0, SHAKE_DISTANCE_M],
      [0, 0, 0],
    ]);
    await response;
  });

  test("a held shake swings until it is released, records once with its duration, and replays as long", async () => {
    const shaken: string[] = [];
    const replayed: Array<number | undefined> = [];
    const app = await startApp("emulator-5612", {
      shake: async (serial, control) => {
        const swung = await holdingShake(shaken)(serial, control);
        if (shaken.length > 1) replayed.push(swung);
        return swung;
      },
    });
    try {
      expect((await app.handleRequest(post("/api/shake", { hold: true }))).status).toBe(200);
      await Bun.sleep(30);
      expect((await app.handleRequest(post("/api/shake", { hold: true }))).status).toBe(200);
      await Bun.sleep(30);
      const released = await app.handleRequest(post("/api/shake", { hold: false }));
      expect(released.status).toBe(200);
      expect(await released.json()).toEqual({ ok: true });
      expect(shaken).toEqual(["emulator-5612"]);

      const session = (await (await app.handleRequest(request("/api/session"))).json()) as {
        events: Array<{ kind: string; durationMs?: number }>;
      };
      expect(session.events).toHaveLength(1);
      const durationMs = session.events[0]!.durationMs!;
      expect(durationMs).toBeGreaterThanOrEqual(55);

      expect((await app.handleRequest(post("/api/session/replay", {}))).status).toBe(200);
      while (replayed.length === 0) await Bun.sleep(2);
      expect(replayed[0]!).toBeGreaterThanOrEqual(durationMs - 5);
    } finally {
      await app.stop();
    }
  });

  test("a hold with a bad value gets 400 and does not shake", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5614", { shake: holdingShake(shaken) });
    try {
      const response = await app.handleRequest(post("/api/shake", { hold: "yes" }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "hold must be a boolean" });
      expect(shaken).toEqual([]);
    } finally {
      await app.stop();
    }
  });

  test("advertises shake for an emulator and shakes it", async () => {
    const shaken: string[] = [];
    const app = await startApp("emulator-5598", { shake: holdingShake(shaken) });
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
        throw new Error("Emulator shake failed: setPhysicalModel: grpc-status 14");
      },
    });
    try {
      const response = await app.handleRequest(request("/api/shake", "POST"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        ok: false,
        error: "Emulator shake failed: setPhysicalModel: grpc-status 14",
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
