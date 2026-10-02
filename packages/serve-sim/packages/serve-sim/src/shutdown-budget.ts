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
  // The losing timer is cleared, so a caller that does not exit right away is not held open.
  const within = async (work: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work.catch(() => {}), new Promise((done) => (timer = setTimeout(done, Math.max(0, ms))))]);
    } finally {
      clearTimeout(timer);
    }
  };
  await within(steps.stopCapture(), steps.captureShareMs);
  await within(steps.disarm(), steps.totalMs - (Date.now() - started));
}
