import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { createReadinessReporter, timeStartup } from "../startup-timing";

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

test("reports unsuccessful returned results without changing them, with device identity", async () => {
  for (const result of [{ exitCode: 1 }, { exitCode: 1, timedOut: true }]) {
    expect(
      await timeStartup("app.install", () => result, "udid", {
        deviceName: "iPhone test",
        isSuccessful: (value) => value.exitCode === 0,
      }),
    ).toBe(result);
    const entries = log.mock.calls
      .slice(-2)
      .map(([line]) => JSON.parse(String(line).slice("[startup] ".length)));
    expect(entries[0]).toMatchObject({
      device: "udid",
      deviceName: "iPhone test",
      status: "started",
    });
    expect(entries[1]).toMatchObject({
      device: "udid",
      deviceName: "iPhone test",
      status: "failed",
    });
  }
});

test("deduplicates readiness independently for alternating devices", () => {
  const report = createReadinessReporter();
  for (let i = 0; i < 3; i++) {
    report("ready", undefined, "A");
    report("unavailable", "capture-start-failed", "B", new Error("failed"));
  }
  expect(log.mock.calls).toHaveLength(2);
  report("ready", undefined, "B");
  report("ready", undefined, "A");
  expect(log.mock.calls).toHaveLength(3);
});
