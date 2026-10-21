// @ref LLP 0011#startup-diagnostics — phase timings and readiness transitions stay on stderr.
export async function timeStartup<T>(
  phase: string,
  run: () => T | Promise<T>,
  device?: string,
): Promise<T> {
  const start = performance.now();
  process.stderr.write(`[startup] ${JSON.stringify({ phase, device, status: "started" })}\n`);
  try {
    const result = await run();
    process.stderr.write(
      `[startup] ${JSON.stringify({ phase, device, status: "complete", durationMs: Math.round(performance.now() - start) })}\n`,
    );
    return result;
  } catch (error) {
    process.stderr.write(
      `[startup] ${JSON.stringify({ phase, device, status: "failed", durationMs: Math.round(performance.now() - start) })}\n`,
    );
    throw error;
  }
}

// One reporter per middleware, so repeated readiness polls do not flood worker logs.
export function createReadinessReporter() {
  let previous: string | undefined;
  return (status: "ready" | "unavailable", reason?: string, device?: string, error?: unknown) => {
    const entry = JSON.stringify({
      status,
      reason,
      device,
      error:
        error instanceof Error ? error.message : error === undefined ? undefined : String(error),
    });
    if (entry === previous) return;
    previous = entry;
    process.stderr.write(`[readyz] ${entry}\n`);
  };
}
