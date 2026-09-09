import type { VideoFrame } from "./scrcpy.ts";

function annexBNalTypes(data: Buffer): Set<number> {
  const types = new Set<number>();
  for (let offset = 0; offset + 3 < data.length; offset++) {
    if (data[offset] !== 0 || data[offset + 1] !== 0) continue;
    const header = data[offset + 2] === 1
      ? offset + 3
      : data[offset + 2] === 0 && data[offset + 3] === 1
        ? offset + 4
        : -1;
    if (header >= 0 && header < data.length) {
      types.add(data[header]! & 0x1f);
      offset = header;
    }
  }
  return types;
}

/** Readiness latch proving that a newly published source is browser-decodable. */
export class H264StartupGate {
  readonly #promise: Promise<void>;
  #resolve!: () => void;
  #reject!: (error: Error) => void;
  #settled = false;
  #ready = false;
  #sawSps = false;
  #sawPps = false;
  #sawKeyFrame = false;

  constructor() {
    this.#promise = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    // A transport can fail before its startup function reaches the await point.
    void this.#promise.catch(() => {});
  }

  get ready(): boolean {
    return this.#ready;
  }

  observe(frame: VideoFrame): void {
    if (this.#settled) return;
    if (frame.isConfig) {
      const types = annexBNalTypes(frame.data);
      this.#sawSps ||= types.has(7);
      this.#sawPps ||= types.has(8);
    }
    this.#sawKeyFrame ||= frame.isKey;
    if (this.#sawSps && this.#sawPps && this.#sawKeyFrame) {
      this.#settled = true;
      this.#ready = true;
      this.#resolve();
    }
  }

  fail(error: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#reject(error);
  }

  wait(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) {
      this.fail(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("H.264 startup aborted", "AbortError"));
    }
    const onAbort = () =>
      this.fail(signal.reason instanceof Error
        ? signal.reason
        : new DOMException("H.264 startup aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      this.fail(
        new Error(
          `timed out waiting for decodable H.264 output after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    return this.#promise.finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  }
}
