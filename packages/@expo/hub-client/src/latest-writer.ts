/** How the newest write ended: its result, or why it failed. */
export type LatestWriteOutcome<T, R> =
  | { value: T; ok: true; result: R }
  | { value: T; ok: false; error: unknown };

/**
 * Sends one write at a time. A value written while one is in flight replaces the queued one,
 * so writes never overlap, never land out of order, and the last choice wins. A failed write
 * does not block later ones. `settled` hears only about a write that nothing newer replaced,
 * so a caller never shows the answer to an older choice.
 */
export function createLatestWriter<T, R>(
  write: (value: T) => Promise<R>,
  settled?: (outcome: LatestWriteOutcome<T, R>) => void,
): (value: T) => void {
  let running = false;
  let queued: { value: T } | null = null;
  const drain = async () => {
    running = true;
    while (queued) {
      const { value } = queued;
      queued = null;
      let outcome: LatestWriteOutcome<T, R>;
      try {
        outcome = { value, ok: true, result: await write(value) };
      } catch (error) {
        outcome = { value, ok: false, error };
      }
      if (!queued) settled?.(outcome);
    }
    running = false;
  };
  return (value) => {
    queued = { value };
    if (!running) void drain();
  };
}
