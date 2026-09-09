import { expect, test } from "bun:test";
import { startPoller, type PollScheduler } from "../src/ui/lib/poller.ts";

test("poller aborts superseded work, clears its timer, and ignores late results", async () => {
  const timer: { tick?: () => void } = {};
  let clearCount = 0;
  const scheduler: PollScheduler = {
    setInterval(callback) {
      timer.tick = callback;
      return 7;
    },
    clearInterval(handle) {
      expect(handle).toBe(7);
      clearCount++;
    },
  };
  const requests: Array<{
    signal: AbortSignal;
    resolve(value: number): void;
    reject(error: unknown): void;
  }> = [];
  const values: number[] = [];
  const errors: unknown[] = [];
  const stop = startPoller({
    intervalMs: 100,
    scheduler,
    request: (signal) =>
      new Promise<number>((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
    onValue: (value) => values.push(value),
    onError: (error) => errors.push(error),
  });

  expect(requests).toHaveLength(1);
  const first = requests[0];
  timer.tick?.();
  expect(first.signal.aborted).toBe(true);
  expect(requests).toHaveLength(2);
  first.resolve(1);
  requests[1].resolve(2);
  await Promise.resolve();
  expect(values).toEqual([2]);

  timer.tick?.();
  const last = requests[2];
  stop();
  stop();
  expect(last.signal.aborted).toBe(true);
  last.reject(new Error("late"));
  await Promise.resolve();
  expect(values).toEqual([2]);
  expect(errors).toEqual([]);
  expect(clearCount).toBe(1);
});
