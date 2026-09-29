export const HID_HEARTBEAT = { pingIntervalMs: 1000, pongTimeoutMs: 10_000 };

/** Ping until a peer stops answering, then release its socket. */
export function createSocketHeartbeat(
  ping: () => void,
  onTimeout: () => void,
  { pingIntervalMs, pongTimeoutMs } = HID_HEARTBEAT,
) {
  let pendingSince: number | null = null;
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  const check = () => {
    if (stopped) return;
    if (pendingSince !== null) {
      if (Date.now() - pendingSince >= pongTimeoutMs) {
        stop();
        onTimeout();
      }
      return;
    }
    pendingSince = Date.now();
    try { ping(); } catch { stop(); onTimeout(); }
  };
  return {
    start() {
      if (started || stopped) return;
      started = true;
      check();
      if (!stopped) {
        timer = setInterval(check, pingIntervalMs);
        timer.unref?.();
      }
    },
    pong() { pendingSince = null; },
    stop,
  };
}
