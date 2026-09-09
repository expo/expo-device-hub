import { describe, expect, test } from "bun:test";
import {
  setEmulatorLocationAsync,
  type LocationChildProcess,
} from "../src/location.ts";

class FakeLocationChild implements LocationChildProcess {
  stdout = {
    setEncoding: () => {},
    on: () => {},
  };
  stderr = {
    setEncoding: () => {},
    on: () => {},
  };
  killSignals: string[] = [];
  #errorListeners: Array<(error: Error) => void> = [];
  #exitListeners: Array<(status: number | null) => void> = [];

  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (status: number | null) => void): unknown;
  once(
    event: "error" | "exit",
    listener: ((error: Error) => void) | ((status: number | null) => void),
  ): unknown {
    if (event === "error") {
      this.#errorListeners.push(listener as (error: Error) => void);
    } else {
      this.#exitListeners.push(listener as (status: number | null) => void);
    }
    return this;
  }

  kill(signal: "SIGKILL"): boolean {
    this.killSignals.push(signal);
    return true;
  }

  emitExit(status: number | null): void {
    for (const listener of this.#exitListeners) listener(status);
  }
}

class TrackingAbortSignal {
  aborted = false;
  reason: unknown;
  listeners = new Set<EventListenerOrEventListenerObject>();

  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    this.listeners.delete(listener);
  }

  abort(): void {
    this.aborted = true;
    this.reason = new DOMException("test abort", "AbortError");
    const event = new Event("abort");
    for (const listener of [...this.listeners]) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  }
}

describe("setEmulatorLocationAsync", () => {
  test("rejects a pre-aborted location update before starting adb", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      setEmulatorLocationAsync(
        "emulator-5554",
        { latitude: 51.5, longitude: -0.12 },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("aborting an active update kills adb and cleans timer and signal listeners", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const update = setEmulatorLocationAsync(
      "emulator-5554",
      { latitude: 51.5, longitude: -0.12 },
      controller.signal,
      (async (_cmd, _args, opts) => {
        observedSignal = opts.signal;
        await new Promise<void>((resolve) =>
          opts.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return {
          status: null,
          signal: "SIGKILL",
          stdout: "",
          stderr: "",
          timedOut: false,
          error: new Error("command was aborted", {
            cause: opts.signal?.reason,
          }),
        };
      }) as typeof import("../src/exec.ts").execText,
    );

    expect(observedSignal).toBe(controller.signal);
    controller.abort(new DOMException("test abort", "AbortError"));

    await expect(update).rejects.toMatchObject({
      name: "AbortError",
      message: "test abort",
    });
  });
});
