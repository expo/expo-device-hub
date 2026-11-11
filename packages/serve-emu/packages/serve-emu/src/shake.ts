import { setTimeout as sleep } from "node:timers/promises";
import { isEmulatorSerial } from "./device-capabilities.ts";
import {
  EmulatorGrpcClient,
  PHYSICAL_MODEL_POSITION,
  ensureEmulatorGrpcEndpoint,
} from "./emulator-grpc.ts";
import { readBodyLimited } from "./request-body.ts";

/**
 * Android has no system shake event: each app reads the accelerometer and runs its own shake
 * detector. serve-emu shakes an emulator the way a hand shakes a phone. It swings the virtual
 * device back and forth through the emulator's physical model (gRPC `setPhysicalModel`), and the
 * emulator computes the accelerometer from that motion.
 *
 * The two detectors that open a dev menu want different shakes. The Expo Go and expo-dev-menu
 * detector toggles the menu after 3 sign changes above 1.33 g, then ignores samples for 600 ms.
 * React Native's own detector (bridgeless, minNumShakes 2) needs 16 sign changes, with no more
 * than 3 s between two of them. A person shakes until the menu appears, so a click swings 3
 * times and a held shake keeps swinging until it is released.
 * Sources: react-native 0.86 `common/ShakeDetector.kt` and `runtime/ReactHostImpl.kt`, expo
 * `expo-dev-menu/.../detectors/ShakeDetector.kt`.
 */
/**
 * The swing moves the device on its z axis, toward and away from the viewer. A swing on x tilts
 * the measured gravity sideways, and on an Android 16 emulator a 2.6 s swing of ±1.5 m on x
 * turned an app with auto-rotate to landscape and back; a swing on z leaves the rotation alone.
 * Both detectors take z as `z - 9.81`, so the swing must pass 22.85 and -3.23 m/s² on z.
 */
const SHAKE_AXIS = 2;
/**
 * How far each swing moves the device, in the physical model's meters. The model smooths each
 * move; ±0.5 m on z at 3 Hz measured about -45 to 50 m/s², and a 15 Hz (SENSOR_DELAY_UI)
 * listener saw a sign change on every swing. ±0.3 m reached 23 m/s² and missed swings.
 */
export const SHAKE_DISTANCE_M = 0.5;
/** Half a swing period: 3 Hz. */
export const SHAKE_SWING_MS = 167;
/** A click swings this many times, which Expo's detector counts as one shake. */
export const SHAKE_MIN_SWINGS = 3;
/** The time the device needs to come back to rest after its last swing. */
export const SHAKE_SETTLE_MS = 500;
/** A held shake stops when no hold request has arrived for this long. */
export const SHAKE_HOLD_LEASE_MS = 1_500;
/** No shake swings for longer than this. */
export const SHAKE_MAX_MS = 20_000;
export const SHAKE_EMULATOR_ONLY_MESSAGE = "Shake is available only on Android Emulator devices";

/** The device is not an emulator, so its physical model cannot move. */
export class ShakeUnsupportedError extends Error {
  constructor() {
    super(SHAKE_EMULATOR_ONLY_MESSAGE);
    this.name = "ShakeUnsupportedError";
  }
}

/** Where a shake is recorded: a server's session recorder. */
export type ShakeRecorder = {
  recordShake(source: string): number | null;
  /** Give a recorded shake the time it swung, so a replay swings as long. */
  setShakeDuration(id: number, durationMs: number): void;
  discard(id: number): void;
};

/** How a running shake learns when to stop, and tells when it started. */
export type ShakeControl = {
  /**
   * Whether to swing again once the minimum swings are done. `elapsedMs` counts from the first
   * swing, the same origin as the duration a shake resolves with.
   */
  keepShaking(elapsedMs: number): boolean;
  /** Called once, after the first swing reached the emulator. */
  started?(): void;
};

/** Shake `serial`; resolves with the time it swung, in ms. */
export type ShakeMotion = (serial: string, control: ShakeControl) => Promise<number>;

/**
 * A running shake. It keeps swinging while `now()` is before `holdUntil`, the end of a hold's
 * lease, or while it has swung for less than `durationMs`, a replay's recorded duration.
 */
type Burst = { done: Promise<void>; started: Promise<void>; holdUntil: number; durationMs: number };

/**
 * One shake per device at a time for one server: clicks, holds and session replay. A click or a
 * replay during a running shake joins it. A hold starts a shake, or keeps the running one swinging
 * for another lease; a release lets it finish. The shake records only before its first swing, so
 * input that arrives during the shake replays after it, and it gets its duration when it ends. A
 * failed shake removes its event, as a failed tap is never recorded. A held shake that fails while
 * it is held keeps its error for the next renewal or the release of that hold, for one lease, so
 * the client sees it instead of a renewal starting a new shake. `serials()` names the devices this
 * server shakes now, replays included, so its stop settles only those.
 */
export function createShakeRunner(shake: ShakeMotion, now: () => number = Date.now) {
  const running = new Map<string, Burst>();
  const failures = new Map<string, { error: unknown; at: number }>();
  const takeFailure = (serial: string): { error: unknown } | null => {
    const failure = failures.get(serial);
    failures.delete(serial);
    return failure && now() - failure.at < SHAKE_HOLD_LEASE_MS ? failure : null;
  };

  const begin = (
    serial: string,
    keep: { holdUntil?: number; durationMs?: number },
    recorder?: ShakeRecorder,
  ): Burst => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const burst: Burst = {
      done: Promise.resolve(),
      started,
      holdUntil: keep.holdUntil ?? 0,
      durationMs: keep.durationMs ?? 0,
    };
    const eventId = recorder ? recorder.recordShake("rest:shake") : null;
    burst.done = shake(serial, {
      keepShaking: (elapsedMs) => elapsedMs < burst.durationMs || now() < burst.holdUntil,
      started: markStarted,
    })
      .then(
        (durationMs) => {
          if (recorder && eventId !== null) recorder.setShakeDuration(eventId, durationMs);
        },
        (error: unknown) => {
          if (recorder && eventId !== null) recorder.discard(eventId);
          if (now() < burst.holdUntil) failures.set(serial, { error, at: now() });
          throw error;
        },
      )
      .finally(() => {
        if (running.get(serial) === burst) running.delete(serial);
      });
    // A held shake can fail after its press was answered and before any release arrives.
    burst.done.catch(() => {});
    running.set(serial, burst);
    return burst;
  };

  return {
    /** A click: the shortest shake. */
    run(serial: string, recorder?: ShakeRecorder): Promise<void> {
      if (!isEmulatorSerial(serial)) return Promise.reject(new ShakeUnsupportedError());
      return (running.get(serial) ?? begin(serial, {}, recorder)).done;
    },
    /**
     * Start a held shake, or keep the running shake swinging for another lease. A new shake
     * resolves after its first swing, or rejects when it fails before it; a renewal resolves at
     * once.
     */
    hold(serial: string, recorder?: ShakeRecorder): Promise<void> {
      if (!isEmulatorSerial(serial)) return Promise.reject(new ShakeUnsupportedError());
      const leaseEnd = now() + SHAKE_HOLD_LEASE_MS;
      const current = running.get(serial);
      if (current) {
        current.holdUntil = Math.max(current.holdUntil, leaseEnd);
        return Promise.resolve();
      }
      const failure = takeFailure(serial);
      if (failure) return Promise.reject(failure.error);
      const burst = begin(serial, { holdUntil: leaseEnd }, recorder);
      return Promise.race([burst.started, burst.done]);
    },
    /**
     * End the hold: the shake finishes its minimum swings, then stops. Resolves when it ends, and
     * rejects with the error of a held shake that failed and that no renewal reported yet.
     */
    release(serial: string): Promise<void> {
      const current = running.get(serial);
      if (!current) {
        const failure = takeFailure(serial);
        return failure ? Promise.reject(failure.error) : Promise.resolve();
      }
      current.holdUntil = 0;
      return current.done;
    },
    /**
     * Replay a recorded shake for its recorded duration; a shake without one is a click. When
     * `signal` aborts, a shake this replay started stops after its current swing and minimum
     * swings, and the promise resolves once the device is back.
     */
    replay(serial: string, durationMs?: number, signal?: AbortSignal): Promise<void> {
      if (!isEmulatorSerial(serial)) return Promise.reject(new ShakeUnsupportedError());
      const current = running.get(serial);
      if (current) return current.done;
      const burst = begin(serial, { durationMs: signal?.aborted ? 0 : durationMs });
      signal?.addEventListener(
        "abort",
        () => {
          burst.durationMs = 0;
        },
        { once: true },
      );
      return burst.done;
    },
    serials(): string[] {
      return [...running.keys()];
    },
  };
}

export type ShakeRunner = ReturnType<typeof createShakeRunner>;

/** A `POST /api/shake` body that is not empty or `{ "hold"?: boolean, "record"?: boolean }`. */
export class ShakeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShakeRequestError";
  }
}

const MAX_SHAKE_BODY_BYTES = 1024;

/** What a `POST /api/shake` asks for. */
export type ShakeRequest = {
  /** True holds the shake, false releases it; null is a click. */
  hold: boolean | null;
  record: boolean;
};

/**
 * Read the optional body of `POST /api/shake`. An empty body or `{}` is a click. `hold: true`
 * starts or renews a held shake and `hold: false` releases it. A shake records into the session
 * by default, as REST actions do; `{ "record": false }` leaves it out.
 */
export async function readShakeRequest(request: Request): Promise<ShakeRequest> {
  const bytes = await readBodyLimited(request, MAX_SHAKE_BODY_BYTES);
  if (bytes.byteLength === 0) return { hold: null, record: true };
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ShakeRequestError("shake payload must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ShakeRequestError("shake payload must be an object");
  }
  const { hold, record } = body as Record<string, unknown>;
  if (record !== undefined && typeof record !== "boolean") {
    throw new ShakeRequestError("record must be a boolean");
  }
  if (hold !== undefined && typeof hold !== "boolean") {
    throw new ShakeRequestError("hold must be a boolean");
  }
  return { hold: hold ?? null, record: record !== false };
}

/** Do what a `POST /api/shake` asked for on `serial`. */
export function runShakeRequest(
  runner: ShakeRunner,
  serial: string,
  request: ShakeRequest,
  recorder: ShakeRecorder | undefined,
): Promise<void> {
  const sessions = request.record ? recorder : undefined;
  if (request.hold === true) return runner.hold(serial, sessions);
  if (request.hold === false) return runner.release(serial);
  return runner.run(serial, sessions);
}

/** The part of the emulator gRPC client a shake uses. */
export type PhysicalModelClient = {
  getPhysicalModel(target: number): Promise<number[]>;
  setPhysicalModel(target: number, data: readonly number[]): Promise<void>;
  close(): void;
};

export type ShakeEmulatorDependencies = {
  connect?(serial: string): Promise<PhysicalModelClient>;
  now?(): number;
  wait?(ms: number): Promise<unknown>;
};

async function connectPhysicalModel(serial: string): Promise<PhysicalModelClient> {
  return new EmulatorGrpcClient(await ensureEmulatorGrpcEndpoint(serial));
}

type RunningShake = { done: Promise<number>; stop(): void; join(control: ShakeControl): void };

const running = new Map<string, RunningShake>();

/**
 * Shake an emulator: read the device position, swing it back and forth on z, then move it back
 * and wait until it rests, also after a failed swing. It swings `SHAKE_MIN_SWINGS` times, then
 * as long as `keepShaking` says so, up to `SHAKE_MAX_MS`. A call that arrives while a shake runs
 * on the same device, such as one from another server in this process, joins it and gets its
 * promise, so the read never sees a moving device. The joined shake swings while any of its
 * controls says so, and tells each one when it started. Resolves with the time it swung, in ms.
 */
export function shakeEmulator(
  serial: string,
  control: ShakeControl = { keepShaking: () => false },
  dependencies: ShakeEmulatorDependencies = {},
): Promise<number> {
  if (!isEmulatorSerial(serial)) return Promise.reject(new ShakeUnsupportedError());
  const current = running.get(serial);
  if (current) {
    current.join(control);
    return current.done;
  }
  const controls = [control];
  let begun = false;
  let stopped = false;
  const combined: ShakeControl = {
    keepShaking: (elapsedMs) => controls.some((each) => each.keepShaking(elapsedMs)),
    started: () => {
      begun = true;
      for (const each of controls) each.started?.();
    },
  };
  const done = runShake(serial, combined, dependencies, () => stopped).finally(() => {
    if (running.get(serial)?.done === done) running.delete(serial);
  });
  running.set(serial, {
    done,
    stop: () => {
      stopped = true;
    },
    join: (joining) => {
      controls.push(joining);
      if (begun) joining.started?.();
    },
  });
  return done;
}

/**
 * Shake `serial` for `durationMs` of swinging, as a session replay does. When `signal` aborts,
 * it stops after its current swing and minimum swings.
 */
export function shakeEmulatorFor(
  serial: string,
  durationMs?: number,
  signal?: AbortSignal,
): Promise<number> {
  return shakeEmulator(serial, {
    keepShaking: (elapsedMs) => !signal?.aborted && elapsedMs < (durationMs ?? 0),
  });
}

/**
 * Stop the shakes that run on `serials`, or on every device, after their current swing, and wait
 * until each one has moved the device back. A server calls this before it stops, so an emulator
 * does not stay moved when the process exits during a shake. It never rejects; a failed move
 * back stays the shake's own error.
 */
export async function settleShakes(serials?: Iterable<string>): Promise<void> {
  const shakes = serials
    ? [...serials].flatMap((serial) => running.get(serial) ?? [])
    : [...running.values()];
  for (const shake of shakes) shake.stop();
  await Promise.allSettled(shakes.map((shake) => shake.done));
}

async function runShake(
  serial: string,
  control: ShakeControl,
  dependencies: ShakeEmulatorDependencies,
  stopped: () => boolean,
): Promise<number> {
  const connect = dependencies.connect ?? connectPhysicalModel;
  const now = dependencies.now ?? Date.now;
  const wait = dependencies.wait ?? sleep;
  const client = await connect(serial);
  try {
    let rest: number[];
    try {
      const [x = 0, y = 0, z = 0] = await client.getPhysicalModel(PHYSICAL_MODEL_POSITION);
      rest = [x, y, z];
    } catch (error) {
      throw new Error(`Emulator position read failed: ${message(error)}`);
    }
    const start = now();
    let swings = 0;
    let durationMs = 0;
    let swingError: unknown = null;
    try {
      while (!stopped()) {
        const elapsed = now() - start;
        if (elapsed >= SHAKE_MAX_MS) break;
        if (swings >= SHAKE_MIN_SWINGS && !control.keepShaking(elapsed)) break;
        const position = [...rest];
        position[SHAKE_AXIS]! += swings % 2 === 0 ? SHAKE_DISTANCE_M : -SHAKE_DISTANCE_M;
        await client.setPhysicalModel(PHYSICAL_MODEL_POSITION, position);
        if (swings === 0) control.started?.();
        swings++;
        await wait(Math.max(0, start + swings * SHAKE_SWING_MS - now()));
      }
      durationMs = now() - start;
    } catch (error) {
      swingError = new Error(`Emulator shake failed: ${message(error)}`);
    }
    try {
      await client.setPhysicalModel(PHYSICAL_MODEL_POSITION, rest);
      await wait(SHAKE_SETTLE_MS);
    } catch (restoreError) {
      const restore = `Emulator position restore failed: ${message(restoreError)}`;
      throw new Error(swingError ? `${message(swingError)}; ${restore}` : restore);
    }
    if (swingError) throw swingError;
    return durationMs;
  } finally {
    client.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
