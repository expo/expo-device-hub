import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { timeStartup } from "../startup-timing";

const log = spyOn(process.stderr, "write").mockImplementation(() => true);
afterEach(() => log.mockClear());
afterAll(() => log.mockRestore());

test("reports a pending phase before it finishes without consuming its result", async () => {
  let finish!: (value: number) => void;
  const pending = timeStartup(
    "bootstatus",
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    "device",
  );
  expect(log.mock.calls).toHaveLength(1);
  expect(log.mock.calls[0]![0]).toContain('"status":"started"');
  finish(42);
  expect(await pending).toBe(42);
  expect(JSON.parse(String(log.mock.calls[1]![0]).slice("[startup] ".length))).toEqual({
    phase: "bootstatus",
    device: "device",
    status: "complete",
    durationMs: expect.any(Number),
  });
});

test("records synchronous and asynchronous failures and preserves the original error", async () => {
  const error = new Error("boot failed");
  for (const run of [
    () => {
      throw error;
    },
    () => Promise.reject(error),
  ]) {
    await expect(timeStartup("bootstatus", run)).rejects.toBe(error);
  }
  expect(
    log.mock.calls.filter(([entry]) => String(entry).includes('"status":"failed"')),
  ).toHaveLength(2);
});
