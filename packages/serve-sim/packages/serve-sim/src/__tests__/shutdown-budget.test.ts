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
