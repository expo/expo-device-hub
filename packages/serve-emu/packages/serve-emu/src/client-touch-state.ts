import type { ControlInputHandle } from "./control-input-queue.ts";
import type { Gesture } from "./input.ts";

type Touch = Extract<Gesture, { type: "touch" }>;

export type TouchInputTarget = {
  /** The input queue, not the longer-lived device or viewer. */
  identity: object;
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

  constructor(target: () => TouchInputTarget, source = "ws") {
    this.#target = target;
    this.#source = source;
  }

  enqueue(gesture: Gesture, record = true): ControlInputHandle {
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
    if (gesture.action === "down" ? previous : !previous) {
      throw new Error(gesture.action === "down" ? "pointer is already down" : "pointer is not down");
    }
    const mapped: Touch = {
      ...gesture,
      pointerId: previous?.gesture.pointerId ?? allocatePointerId(target.identity),
    };
    const accepted = target.enqueue(mapped, this.#source, record);
    // Track admission, not completion: close can race an in-flight DOWN. A
    // rejected enqueue must not create a pointer or consume release capacity.
    if (gesture.action === "up") this.#touches.delete(localId);
    else this.#touches.set(localId, { gesture: mapped, record: record || previous?.record === true });
    return accepted;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      const current = this.#current;
      if (!current || current.identity !== this.#target().identity) return;
      for (const { gesture, record } of this.#touches.values()) {
        try {
          // The queue reserves an UP for every admitted DOWN, even when full.
          const release = current.enqueue({ ...gesture, action: "up" }, `${this.#source}:disconnect`, record);
          void release.completion.catch(() => {});
        } catch {
          // A stopped/replaced input session owns its own transport teardown.
        }
      }
    } finally {
      this.#touches.clear();
      this.#current = null;
    }
  }
}

/** Replay IDs describe recorded gestures, not pointers owned by a live viewer. */
export function replayTouchInput(target: () => TouchInputTarget) {
  const inputs = new WeakMap<AbortSignal, ClientTouchState>();
  return (gesture: Gesture, signal: AbortSignal): ControlInputHandle => {
    let input = inputs.get(signal);
    if (!input) {
      input = new ClientTouchState(target, "session:replay");
      inputs.set(signal, input);
      const captured = input;
      signal.addEventListener("abort", () => captured.close(), { once: true });
    }
    return input.enqueue(gesture, false);
  };
}
