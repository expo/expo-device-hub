import { expect, test } from "bun:test";

import { runShutdownSteps } from "../shutdown-budget";

test("disarms even when capture teardown stalls past its share", async () => {
  const order: string[] = [];
  const started = Date.now();
  await runShutdownSteps({
    stopCapture: () => new Promise(() => order.push("capture")),
    disarm: async () => void order.push("disarm"),
    totalMs: 400,
    captureShareMs: 100,
  });
  expect(order).toEqual(["capture", "disarm"]);
  expect(Date.now() - started).toBeLessThan(350);
});

test("keeps the whole budget bounded when both steps stall", async () => {
  const started = Date.now();
  await runShutdownSteps({
    stopCapture: () => new Promise(() => {}),
    disarm: () => new Promise(() => {}),
    totalMs: 300,
    captureShareMs: 100,
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(290);
  expect(elapsed).toBeLessThan(600);
});

test("disarms after a failed capture teardown", async () => {
  let disarmed = false;
  await runShutdownSteps({
    stopCapture: async () => {
      throw new Error("teardown failed");
    },
    disarm: async () => void (disarmed = true),
    totalMs: 300,
    captureShareMs: 100,
  });
  expect(disarmed).toBe(true);
});

test("leaves no timer running once both steps finish early", async () => {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = originalSet(() => {
      live.delete(id);
      fn();
    }, ms);
    live.add(id);
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    live.delete(id);
    originalClear(id);
  }) as typeof clearTimeout;
  try {
    await runShutdownSteps({ stopCapture: async () => {}, disarm: async () => {}, totalMs: 60_000, captureShareMs: 30_000 });
    expect(live.size).toBe(0);
  } finally {
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
});
