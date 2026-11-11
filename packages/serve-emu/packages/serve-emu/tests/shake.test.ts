import { describe, expect, test } from "bun:test";
import {
  SHAKE_DISTANCE_M,
  SHAKE_EMULATOR_ONLY_MESSAGE,
  SHAKE_HOLD_LEASE_MS,
  SHAKE_MAX_MS,
  SHAKE_MIN_SWINGS,
  SHAKE_SETTLE_MS,
  SHAKE_SWING_MS,
  ShakeRequestError,
  ShakeUnsupportedError,
  createShakeRunner,
  readShakeRequest,
  settleShakes,
  shakeEmulator,
  type PhysicalModelClient,
  type ShakeControl,
} from "../src/shake.ts";

const REST = [0.25, 0, -0.5];

/**
 * An emulator physical model that rests at `REST` and a clock that only moves when the shake
 * waits. `fail` can refuse a read or a set, by its number (1 is the first) or its position.
 */
function fakeEmulator(
  fail: { read?: boolean; set?: (index: number, data: readonly number[]) => boolean } = {},
) {
  const positions: number[][] = [];
  const waits: number[] = [];
  let now = 0;
  let connects = 0;
  let closed = 0;
  let gate: Promise<void> | null = null;
  const client: PhysicalModelClient = {
    async getPhysicalModel(target) {
      expect(target).toBe(0);
      if (fail.read) throw new Error("getPhysicalModel: grpc-status 14");
      return [...REST];
    },
    async setPhysicalModel(target, data) {
      expect(target).toBe(0);
      positions.push([...data]);
      if (fail.set?.(positions.length, data)) throw new Error("setPhysicalModel: grpc-status 14");
    },
    close() {
      closed++;
    },
  };
  return {
    positions,
    waits,
    get connects() {
      return connects;
    },
    get closed() {
      return closed;
    },
    /** Hold the first wait until `open` runs. */
    holdFirstWait() {
      let open!: () => void;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => open();
    },
    dependencies: {
      connect: async () => {
        connects++;
        return client;
      },
      now: () => now,
      wait: async (ms: number) => {
        waits.push(ms);
        if (gate) {
          const held = gate;
          gate = null;
          await held;
        }
        now += ms;
      },
    },
  };
}

const click: ShakeControl = { keepShaking: () => false };
// The swing is on z, so a shake does not tilt gravity sideways and rotate the screen.
const swing = (sign: 1 | -1) => [REST[0]!, REST[1]!, REST[2]! + sign * SHAKE_DISTANCE_M];

describe("shakeEmulator", () => {
  test("a click swings 3 times around the resting position, then moves back and waits until it rests", async () => {
    const emulator = fakeEmulator();

    const durationMs = await shakeEmulator("emulator-5554", click, emulator.dependencies);

    expect(SHAKE_MIN_SWINGS).toBe(3);
    expect(emulator.positions).toEqual([swing(1), swing(-1), swing(1), REST]);
    expect(emulator.waits).toEqual([
      SHAKE_SWING_MS,
      SHAKE_SWING_MS,
      SHAKE_SWING_MS,
      SHAKE_SETTLE_MS,
    ]);
    expect(durationMs).toBe(3 * SHAKE_SWING_MS);
    expect(emulator.closed).toBe(1);
  });

  test("asks whether to keep shaking only after the minimum swings, and swings while it says so", async () => {
    const emulator = fakeEmulator();
    const asked: number[] = [];

    await shakeEmulator(
      "emulator-5556",
      {
        keepShaking: () => {
          asked.push(emulator.positions.length);
          return asked.length <= 2;
        },
      },
      emulator.dependencies,
    );

    expect(asked).toEqual([3, 4, 5]);
    expect(emulator.positions).toEqual([swing(1), swing(-1), swing(1), swing(-1), swing(1), REST]);
  });

  test("stops swinging at the maximum time even while it is held", async () => {
    const emulator = fakeEmulator();

    const durationMs = await shakeEmulator(
      "emulator-5558",
      { keepShaking: () => true },
      emulator.dependencies,
    );

    expect(durationMs).toBeGreaterThanOrEqual(SHAKE_MAX_MS);
    expect(durationMs).toBeLessThan(SHAKE_MAX_MS + SHAKE_SWING_MS);
    expect(emulator.positions.at(-1)).toEqual(REST);
  });

  test("tells when the first swing reached the emulator, once", async () => {
    const emulator = fakeEmulator();
    const started: number[] = [];

    await shakeEmulator(
      "emulator-5560",
      { keepShaking: () => false, started: () => started.push(emulator.positions.length) },
      emulator.dependencies,
    );

    expect(started).toEqual([1]);
  });

  test("refuses a physical device without connecting to it", async () => {
    const emulator = fakeEmulator();

    const shake = shakeEmulator("R58M123ABC", click, emulator.dependencies);

    await expect(shake).rejects.toBeInstanceOf(ShakeUnsupportedError);
    await expect(shake).rejects.toThrow(SHAKE_EMULATOR_ONLY_MESSAGE);
    expect(emulator.connects).toBe(0);
  });

  test("a failed position read moves nothing and closes the connection", async () => {
    const emulator = fakeEmulator({ read: true });

    await expect(shakeEmulator("emulator-5562", click, emulator.dependencies)).rejects.toThrow(
      "Emulator position read failed: getPhysicalModel: grpc-status 14",
    );
    expect(emulator.positions).toEqual([]);
    expect(emulator.closed).toBe(1);
  });

  test("moves back after a failed swing, reports the swing, and never says it started", async () => {
    const emulator = fakeEmulator({ set: (index) => index === 1 });
    let started = false;

    await expect(
      shakeEmulator(
        "emulator-5564",
        { keepShaking: () => false, started: () => (started = true) },
        emulator.dependencies,
      ),
    ).rejects.toThrow("Emulator shake failed: setPhysicalModel: grpc-status 14");
    expect(emulator.positions).toEqual([swing(1), REST]);
    expect(started).toBe(false);
  });

  test("reports both errors when a swing and the move back fail", async () => {
    const emulator = fakeEmulator({ set: (index) => index >= 2 });

    const error = await shakeEmulator("emulator-5566", click, emulator.dependencies).catch(
      (e: Error) => e,
    );
    expect((error as Error).message).toMatch(/Emulator shake failed/);
    expect((error as Error).message).toMatch(/Emulator position restore failed/);
  });

  test("a call during a running shake joins it instead of starting another one", async () => {
    const emulator = fakeEmulator();
    const open = emulator.holdFirstWait();

    const first = shakeEmulator("emulator-5568", click, emulator.dependencies);
    const second = shakeEmulator("emulator-5568", click, emulator.dependencies);
    expect(second).toBe(first);
    open();
    await Promise.all([first, second]);
    expect(emulator.connects).toBe(1);

    // A later call starts its own shake.
    await shakeEmulator("emulator-5568", click, emulator.dependencies);
    expect(emulator.connects).toBe(2);
  });

  test("settling stops a running shake after its current swing and waits for the move back", async () => {
    const emulator = fakeEmulator();
    const open = emulator.holdFirstWait();

    const shake = shakeEmulator(
      "emulator-5572",
      { keepShaking: () => true },
      emulator.dependencies,
    );
    while (emulator.positions.length === 0) await Bun.sleep(1);
    let settled = false;
    const settling = settleShakes(["emulator-5572"]).then(() => {
      settled = true;
    });
    await Bun.sleep(5);
    expect(settled).toBe(false);

    open();
    await settling;
    await shake;
    expect(emulator.positions).toEqual([swing(1), REST]);
  });

  test("settling resolves when nothing runs and when the move back fails", async () => {
    await settleShakes();
    const emulator = fakeEmulator({ set: (_index, data) => data[0] === REST[0] });
    const shake = shakeEmulator("emulator-5574", click, emulator.dependencies);
    await settleShakes(["emulator-5574"]);
    await expect(shake).rejects.toThrow("restore");
  });

  test("a failed shake does not block the next one", async () => {
    const failing = fakeEmulator({ read: true });
    await expect(shakeEmulator("emulator-5570", click, failing.dependencies)).rejects.toThrow();

    const working = fakeEmulator();
    await shakeEmulator("emulator-5570", click, working.dependencies);
    expect(working.positions).toHaveLength(SHAKE_MIN_SWINGS + 1);
  });
});

describe("createShakeRunner", () => {
  function recorder() {
    const calls: string[] = [];
    let nextId = 1;
    return {
      calls,
      recordShake: (source: string) => {
        calls.push(`record:${source}`);
        return nextId++;
      },
      setShakeDuration: (id: number, durationMs: number) => {
        calls.push(`duration:${id}:${durationMs}`);
      },
      discard: (id: number) => {
        calls.push(`discard:${id}`);
      },
    };
  }

  /** A shake that starts at once and ends when `end` runs; `control` is what the runner gave it. */
  function controlledShake() {
    const state = {
      control: null as ShakeControl | null,
      shakes: 0,
      end: (_durationMs: number) => {},
      fail: (_error: Error) => {},
    };
    const shake = (_serial: string, control: ShakeControl) => {
      state.shakes++;
      state.control = control;
      control.started?.();
      return new Promise<number>((resolve, reject) => {
        state.end = resolve;
        state.fail = reject;
      });
    };
    return { state, shake };
  }

  test("a click or replay during a running shake joins it and shares its recording choice", async () => {
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake);
    const sessions = recorder();

    const first = runner.run("emulator-5620");
    expect(runner.run("emulator-5620", sessions)).toBe(first);
    expect(runner.replay("emulator-5620", 900)).toBe(first);
    expect(runner.serials()).toEqual(["emulator-5620"]);
    state.end(0);
    await first;

    expect(state.shakes).toBe(1);
    expect(sessions.calls).toEqual([]);
    expect(runner.serials()).toEqual([]);
  });

  test("records before the shake and gives the event the time it swung", async () => {
    const sessions = recorder();
    const runner = createShakeRunner(async () => {
      sessions.calls.push("shake");
      return 501;
    });

    await runner.run("emulator-5622", sessions);
    expect(sessions.calls).toEqual(["record:rest:shake", "shake", "duration:1:501"]);
  });

  test("discards the recorded event when the shake fails", async () => {
    const sessions = recorder();
    const runner = createShakeRunner(async () => {
      throw new Error("Emulator shake failed: setPhysicalModel: grpc-status 14");
    });

    await expect(runner.run("emulator-5624", sessions)).rejects.toThrow("grpc-status 14");
    expect(sessions.calls).toEqual(["record:rest:shake", "discard:1"]);
  });

  test("a click does not keep shaking after its minimum swings", async () => {
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake, () => 0);

    const done = runner.run("emulator-5626");
    expect(state.control!.keepShaking()).toBe(false);
    state.end(0);
    await done;
  });

  test("a hold keeps shaking while it is renewed within the lease, and a release lets it end", async () => {
    let now = 1_000;
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake, () => now);
    const sessions = recorder();

    await runner.hold("emulator-5628", sessions);
    expect(state.control!.keepShaking()).toBe(true);
    now += SHAKE_HOLD_LEASE_MS - 1;
    expect(state.control!.keepShaking()).toBe(true);
    await runner.hold("emulator-5628", sessions);
    now += SHAKE_HOLD_LEASE_MS - 1;
    expect(state.control!.keepShaking()).toBe(true);

    let ended = false;
    const release = runner.release("emulator-5628").then(() => {
      ended = true;
    });
    expect(state.control!.keepShaking()).toBe(false);
    await Bun.sleep(1);
    expect(ended).toBe(false);
    state.end(3_200);
    await release;

    expect(state.shakes).toBe(1);
    expect(sessions.calls).toEqual(["record:rest:shake", "duration:1:3200"]);
  });

  test("a hold stops shaking when its lease runs out without a renewal", async () => {
    let now = 0;
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake, () => now);

    await runner.hold("emulator-5630");
    now = SHAKE_HOLD_LEASE_MS;
    expect(state.control!.keepShaking()).toBe(false);
    state.end(0);
  });

  test("a hold during a click keeps that shake going instead of starting another", async () => {
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake, () => 0);

    const clickDone = runner.run("emulator-5632");
    expect(state.control!.keepShaking()).toBe(false);
    await runner.hold("emulator-5632");
    expect(state.control!.keepShaking()).toBe(true);
    expect(state.shakes).toBe(1);
    const released = runner.release("emulator-5632");
    state.end(0);
    await Promise.all([clickDone, released]);
  });

  test("a hold whose shake fails before its first swing rejects with the error", async () => {
    const runner = createShakeRunner(async () => {
      throw new Error("could not enable the emulator gRPC endpoint");
    });

    await expect(runner.hold("emulator-5634")).rejects.toThrow("gRPC endpoint");
    expect(runner.serials()).toEqual([]);
  });

  test("a release with nothing running resolves", async () => {
    const runner = createShakeRunner(async () => 0);
    await runner.release("emulator-5636");
  });

  test("a replay keeps shaking for the recorded duration; one without a duration is a click", async () => {
    let now = 0;
    const { state, shake } = controlledShake();
    const runner = createShakeRunner(shake, () => now);

    const held = runner.replay("emulator-5638", 900);
    now = 899;
    expect(state.control!.keepShaking()).toBe(true);
    now = 900;
    expect(state.control!.keepShaking()).toBe(false);
    state.end(900);
    await held;

    const clicked = runner.replay("emulator-5638");
    expect(state.control!.keepShaking()).toBe(false);
    state.end(0);
    await clicked;
  });

  test("refuses a physical device without shaking or recording", async () => {
    const sessions = recorder();
    let shakes = 0;
    const runner = createShakeRunner(async () => {
      shakes++;
      return 0;
    });

    await expect(runner.run("A", sessions)).rejects.toThrow(SHAKE_EMULATOR_ONLY_MESSAGE);
    await expect(runner.hold("A", sessions)).rejects.toThrow(SHAKE_EMULATOR_ONLY_MESSAGE);
    await expect(runner.replay("A", 500)).rejects.toThrow(SHAKE_EMULATOR_ONLY_MESSAGE);
    expect(shakes).toBe(0);
    expect(sessions.calls).toEqual([]);
  });
});

describe("readShakeRequest", () => {
  const read = (body?: string) =>
    readShakeRequest(new Request("http://router.test/api/shake", { method: "POST", body }));

  test("an empty body or {} is a click that records", async () => {
    expect(await read()).toEqual({ hold: null, record: true });
    expect(await read("{}")).toEqual({ hold: null, record: true });
  });

  test("hold true holds, hold false releases, and record false leaves the shake out", async () => {
    expect(await read('{"hold":true}')).toEqual({ hold: true, record: true });
    expect(await read('{"hold":false,"record":false}')).toEqual({ hold: false, record: false });
  });

  test("refuses a hold or record that is not a boolean, and a body that is not an object", async () => {
    await expect(read('{"hold":"yes"}')).rejects.toBeInstanceOf(ShakeRequestError);
    await expect(read('{"record":1}')).rejects.toThrow("record must be a boolean");
    await expect(read("[]")).rejects.toThrow("shake payload must be an object");
    await expect(read("nope")).rejects.toThrow("shake payload must be JSON");
  });
});
