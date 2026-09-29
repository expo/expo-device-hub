import type { ControlInputHandle } from "./control-input-queue.ts";
import type { Gesture } from "./input.ts";

type Touch = Extract<Gesture, { type: "touch" }>;

export type TouchInputTarget = {
  /** The input queue, not the longer-lived device or viewer. */
  identity: object;
  /** The recording lifetime; IDs must not repeat when its capture is replaced. */
  pointerNamespace: object;
  enqueue(gesture: Gesture, source: string, record: boolean): ControlInputHandle;
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
  readonly #touches = new Map<number, { gesture: Touch; record: boolean }>();
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
      this.#current = target;
    }
    if (gesture.type !== "touch") return target.enqueue(gesture, this.#source, record);

    const localId = gesture.pointerId ?? 0;
    const previous = this.#touches.get(localId);
    if (!previous && gesture.action !== "down" && skipOrphanTouches) {
      // The bounded replay buffer can begin in the middle of a gesture. Do not
      // attach that retained MOVE/UP to a pointer owned by a live viewer.
      return { gesture, completion: Promise.resolve({ status: "coalesced" }) };
    }
    if (gesture.action === "down" ? previous : !previous) {
      throw new Error(
        gesture.action === "down" ? "pointer is already down" : "pointer is not down",
      );
    }
    const mapped: Touch = {
      ...gesture,
      pointerId: previous?.gesture.pointerId ?? allocatePointerId(target.pointerNamespace),
    };
    const accepted = target.enqueue(mapped, this.#source, record);
    // Track admission, not completion: close can race an in-flight DOWN. A
    // rejected enqueue must not create a pointer or consume release capacity.
    if (gesture.action === "up") this.#touches.delete(localId);
    else
      this.#touches.set(localId, { gesture: mapped, record: record || previous?.record === true });
    return accepted;
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
      const current = this.#current;
      if (current && current.identity === this.#target().identity) {
        for (const { gesture, record } of this.#touches.values()) {
          try {
            // The queue reserves an UP for every admitted DOWN, even when full.
            releases.push(
              current.enqueue({ ...gesture, action: "up" }, `${this.#source}:disconnect`, record)
                .completion,
            );
          } catch (error) {
            releases.push(Promise.reject(error));
          }
        }
      }
    } catch (error) {
      releases.push(Promise.reject(error));
    } finally {
      this.#touches.clear();
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
