// Skip the tick rather than queue behind a stalled sample. Under load that queue
// would outlive the stall it was meant to observe.
export function startExclusivePoll(
  sample: () => Promise<void>,
  intervalMs: number,
): () => void {
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await sample();
    } catch {
      // sample() already handled the failure; this only prevents an unhandled rejection.
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
