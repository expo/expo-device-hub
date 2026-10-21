import {
  ControlInputRejectedError,
  type ControlInputCompletion,
  type ControlInputHandle,
} from "./control-input-queue.ts";
import type { Gesture } from "./input.ts";

type Touch = Extract<Gesture, { type: "touch" }>;
type Key = Extract<Gesture, { type: "key" }>;

export type TouchInputTarget = {
  /** The input queue, not the longer-lived device or viewer. */
  identity: object;
  /** The recording lifetime; IDs must not repeat when its capture is replaced. */
  pointerNamespace: object;
  enqueue(gesture: Gesture, source: string, record: boolean): ControlInputHandle;
};

// A held key (a DOWN with its own UP, such as a hardware button) has the same lifecycle.
type TouchCycle<G extends Touch | Key = Touch | Key> = {
  target: TouchInputTarget;
  gesture: G;
  record: boolean;
  down: Promise<ControlInputCompletion>;
  downRejected: boolean;
  up: Promise<ControlInputCompletion> | null;
};

// Zero remains available to the atomic tap/swipe commands. Both binary scrcpy
// and emulator gRPC input can represent these positive signed 32-bit IDs.
const nextPointerIds = new WeakMap<object, number>();
function allocatePointerId(target: object): number {
  const id = nextPointerIds.get(target) ?? 1;
  if (id > 0x7fffffff) throw new Error("touch pointer id space exhausted");
  nextPointerIds.set(target, id + 1);
  return id;
}

/** One input owner's touches, admitted synchronously and released through its queue. */
export class ClientTouchState {
  readonly #target: () => TouchInputTarget;
  readonly #source: string;
  readonly #touches = new Map<number, TouchCycle<Touch>>();
  // An admitted UP allows a new gesture with the same local ID. Keep the old
  // cycle until its release succeeds so a late rejection cannot lose ownership.
  readonly #unreleased = new Set<TouchCycle>();
  readonly #keys = new Map<number, TouchCycle>();
  // Every DOWN of a held key; the key counts as never pressed only when all were rejected.
  readonly #keyDowns = new WeakMap<TouchCycle, Promise<ControlInputCompletion>[]>();
  // Key cycles with a DOWN that reached the device; later repeats cannot change that.
  readonly #pressedKeys = new WeakSet<TouchCycle>();
  #current: TouchInputTarget | null = null;
  #closed = false;
  #closeTask: Promise<void> | null = null;

  constructor(target: () => TouchInputTarget, source = "ws") {
    this.#target = target;
    this.#source = source;
  }

  enqueue(gesture: Gesture, record = true, skipOrphanTouches = false): ControlInputHandle {
    if (this.#closed) throw new Error("input client is closed");
    const target = this.#target();
    if (target.identity !== this.#current?.identity) {
      // A surviving viewer must start a new gesture after capture replacement.
      // Never redirect its old pointer releases to the new input queue.
      this.#touches.clear();
      this.#unreleased.clear();
      this.#keys.clear();
      this.#current = target;
    }
    if (gesture.type === "key") return this.#enqueueKey(target, gesture, record);
    if (gesture.type !== "touch") return target.enqueue(gesture, this.#source, record);

    const localId = gesture.pointerId ?? 0;
    const previous = this.#touches.get(localId);
    const held = previous && !previous.up && !previous.downRejected;
    if (!held && gesture.action !== "down" && skipOrphanTouches) {
      // A bounded replay can start in the middle of a gesture.
      return { gesture, completion: Promise.resolve({ status: "coalesced" }) };
    }
    if (gesture.action === "down" ? held : !held) {
      throw new Error(
        gesture.action === "down" ? "pointer is already down" : "pointer is not down",
      );
    }
    const mapped: Touch = {
      ...gesture,
      pointerId:
        gesture.action === "down"
          ? allocatePointerId(target.pointerNamespace)
          : previous!.gesture.pointerId,
    };
    const accepted = target.enqueue(mapped, this.#source, record);
    const cycle: TouchCycle<Touch> =
      gesture.action === "down"
        ? {
            target,
            gesture: mapped,
            record,
            down: accepted.completion,
            downRejected: false,
            up: null,
          }
        : previous!;
    cycle.gesture = mapped;
    cycle.record ||= record;
    if (gesture.action === "down") {
      this.#touches.set(localId, cycle);
      this.#unreleased.add(cycle);
    }
    const completion = accepted.completion.then(
      (result) => {
        if (gesture.action === "up") {
          this.#unreleased.delete(cycle);
          if (this.#touches.get(localId) === cycle) this.#touches.delete(localId);
        }
        return result;
      },
      (error: unknown) => {
        if (error instanceof ControlInputRejectedError) {
          if (gesture.action === "down") {
            cycle.downRejected = true;
            this.#unreleased.delete(cycle);
            if (this.#touches.get(localId) === cycle) this.#touches.delete(localId);
          } else if (gesture.action === "up" && cycle.up === completion) {
            cycle.up = null;
          }
        }
        throw error;
      },
    );
    if (gesture.action === "down") cycle.down = completion;
    else if (gesture.action === "up") cycle.up = completion;
    return { ...accepted, completion };
  }

  #enqueueKey(target: TouchInputTarget, gesture: Key, record: boolean): ControlInputHandle {
    const accepted = target.enqueue(gesture, this.#source, record);
    if (!gesture.action) return accepted;
    const keycode = gesture.keycode;
    const previous = this.#keys.get(keycode);
    const held = previous && !previous.up && !previous.downRejected;
    if (gesture.action === "down") {
      // A repeated DOWN of a held key joins the original cycle and its single release.
      const cycle: TouchCycle = held
        ? previous
        : { target, gesture, record, down: accepted.completion, downRejected: false, up: null };
      if (!held) {
        this.#keys.set(keycode, cycle);
        this.#unreleased.add(cycle);
      }
      if (this.#pressedKeys.has(cycle)) return accepted;
      const downs = this.#keyDowns.get(cycle) ?? [];
      this.#keyDowns.set(cycle, downs);
      downs.push(accepted.completion);
      // Fulfills when any DOWN reached the device. It rejects with a rejection error only when
      // every DOWN was rejected, which tells close that nothing is left to release.
      const anyDown = Promise.any(downs).catch((error: AggregateError) => {
        throw (
          error.errors.find((reason) => !(reason instanceof ControlInputRejectedError)) ??
          error.errors.at(-1)
        );
      });
      anyDown.catch(() => {});
      cycle.down = anyDown;
      void anyDown.then(
        () => {
          this.#pressedKeys.add(cycle);
          this.#keyDowns.delete(cycle);
        },
        () => {},
      );
      const completion = accepted.completion.then(
        (result) => result,
        (error: unknown) => {
          if (error instanceof ControlInputRejectedError) {
            void anyDown.then(
              () => {},
              (reason: unknown) => {
                // Only the last of a cycle's DOWNs to settle sees every one rejected.
                if (reason instanceof ControlInputRejectedError && cycle.down === anyDown) {
                  cycle.downRejected = true;
                  this.#unreleased.delete(cycle);
                  if (this.#keys.get(keycode) === cycle) this.#keys.delete(keycode);
                }
              },
            );
          }
          throw error;
        },
      );
      return { ...accepted, completion };
    }
    if (!held) return accepted;
    const cycle = previous;
    cycle.record ||= record;
    // Keep the cycle until its UP succeeds, so close can retry a rejected UP.
    const completion: Promise<ControlInputCompletion> = accepted.completion.then(
      (result) => {
        this.#unreleased.delete(cycle);
        if (this.#keys.get(keycode) === cycle) this.#keys.delete(keycode);
        return result;
      },
      (error: unknown) => {
        if (error instanceof ControlInputRejectedError && cycle.up === completion) cycle.up = null;
        throw error;
      },
    );
    cycle.up = completion;
    return { ...accepted, completion };
  }

  #queueRelease(cycle: TouchCycle): Promise<void> {
    if (cycle.downRejected || cycle.target.identity !== this.#target().identity) {
      return Promise.resolve();
    }
    let release: Promise<ControlInputCompletion>;
    try {
      release = cycle.target.enqueue(
        { ...cycle.gesture, action: "up" },
        `${this.#source}:disconnect`,
        cycle.record,
      ).completion;
    } catch (error) {
      release = Promise.reject(error);
    }
    return release.then(
      () => {},
      async (error: unknown) => {
        try {
          await cycle.down;
        } catch (downError) {
          // The queue cancels a dependent UP when its DOWN was rejected. Nothing
          // was pressed, so cleanup is complete rather than a release failure.
          if (downError instanceof ControlInputRejectedError) return;
        }
        throw error;
      },
    );
  }

  #releaseCycle(cycle: TouchCycle): Promise<void> {
    if (!cycle.up) return this.#queueRelease(cycle);
    return cycle.up.then(
      () => {},
      async (error: unknown) => {
        if (!(error instanceof ControlInputRejectedError)) throw error;
        try {
          await cycle.down;
        } catch (downError) {
          if (downError instanceof ControlInputRejectedError) return;
          throw downError;
        }
        // A user UP already in flight is not duplicated. If it is rejected, send
        // one cleanup UP; failure of that cleanup is reported without retrying.
        return this.#queueRelease(cycle);
      },
    );
  }

  close(): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    // Publish the result before enqueueing: abort and finish must observe the
    // same cleanup, including its failure, rather than enqueueing duplicate UPs.
    this.#closeTask = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const releases: Promise<unknown>[] = [];
    try {
      for (const cycle of this.#unreleased) {
        try {
          releases.push(this.#releaseCycle(cycle));
        } catch (error) {
          releases.push(Promise.reject(error));
        }
      }
    } finally {
      this.#touches.clear();
      this.#unreleased.clear();
      this.#keys.clear();
      this.#current = null;
    }
    // Try every release and wait for all of them, even if one fails first.
    void Promise.allSettled(releases).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure) reject(failure.reason);
      else resolve();
    });
    return this.#closeTask;
  }
}

/** Replay IDs describe recorded gestures, not pointers owned by a live viewer. */
export function replayTouchInput(target: () => TouchInputTarget) {
  const inputs = new WeakMap<AbortSignal, ClientTouchState>();
  return {
    enqueue(gesture: Gesture, signal: AbortSignal): ControlInputHandle {
      let input = inputs.get(signal);
      if (!input) {
        input = new ClientTouchState(target, "session:replay");
        inputs.set(signal, input);
        const captured = input;
        signal.addEventListener(
          "abort",
          () => {
            void captured.close().catch(() => {});
          },
          { once: true },
        );
      }
      return input.enqueue(gesture, false, true);
    },
    finish(signal: AbortSignal): Promise<void> {
      // Keep the signal-keyed entry so repeated finalization shares the result.
      // The WeakMap releases it when the replay signal is no longer retained.
      return inputs.get(signal)?.close() ?? Promise.resolve();
    },
  };
}
