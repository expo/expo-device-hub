// @ref LLP 0011#startup-diagnostics — phase timings and readiness transitions stay on stderr.
export async function timeStartup<T>(
  phase: string,
  run: () => T | Promise<T>,
  device?: string,
  options: { deviceName?: string; isSuccessful?: (result: T) => boolean } = {},
): Promise<T> {
  const start = performance.now();
  const identity = { phase, device, deviceName: options.deviceName };
  process.stderr.write(`[startup] ${JSON.stringify({ ...identity, status: "started" })}\n`);
  try {
    const result = await run();
    process.stderr.write(
      `[startup] ${JSON.stringify({ ...identity, status: options.isSuccessful?.(result) === false ? "failed" : "complete", durationMs: Math.round(performance.now() - start) })}\n`,
    );
    return result;
  } catch (error) {
    process.stderr.write(
      `[startup] ${JSON.stringify({ ...identity, status: "failed", durationMs: Math.round(performance.now() - start) })}\n`,
    );
    throw error;
  }
}

// One reporter per middleware, so repeated readiness polls do not flood worker logs.
export function createReadinessReporter() {
  const previous = new Map<string | null, string>();
  return (
    status: "ready" | "unavailable",
    reason?: string,
    device?: string,
    error?: unknown,
    selector: string | null = device ?? null,
  ) => {
    const entry = JSON.stringify({
      status,
      reason,
      device,
      error:
        error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
    if (entry === previous.get(selector)) return;
    // Bound diagnostics for arbitrary /readyz?device= selectors.
    if (!previous.has(selector) && previous.size >= 256) {
      previous.delete(previous.keys().next().value ?? null);
    }
    previous.set(selector, entry);
    process.stderr.write(`[readyz] ${entry}\n`);
  };
}
