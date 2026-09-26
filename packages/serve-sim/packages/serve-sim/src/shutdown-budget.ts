/**
 * Run shutdown's two steps inside one time budget. Capture teardown gets at most `captureShareMs`,
 * so disarming the devices always starts, even when a capture step stalls, and gets the rest.
 */
export async function runShutdownSteps(steps: {
  stopCapture: () => Promise<unknown>;
  disarm: () => Promise<unknown>;
  totalMs: number;
  captureShareMs: number;
}): Promise<void> {
  const started = Date.now();
  const within = (work: Promise<unknown>, ms: number) =>
    Promise.race([work.catch(() => {}), new Promise((done) => setTimeout(done, Math.max(0, ms)))]);
  await within(steps.stopCapture(), steps.captureShareMs);
  await within(steps.disarm(), steps.totalMs - (Date.now() - started));
}
