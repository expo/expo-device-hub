/**
 * Sends one write at a time. A value written while one is in flight replaces the queued one,
 * so writes never overlap, never land out of order, and the last choice wins.
 */
export function createLatestWriter<T>(write: (value: T) => Promise<unknown>): (value: T) => void {
  let running = false;
  let queued: { value: T } | null = null;
  const drain = async () => {
    running = true;
    while (queued) {
      const { value } = queued;
      queued = null;
      try {
        await write(value);
      } catch {
        // A failed write does not block later choices.
      }
    }
    running = false;
  };
  return (value) => {
    queued = { value };
    if (!running) void drain();
  };
}
