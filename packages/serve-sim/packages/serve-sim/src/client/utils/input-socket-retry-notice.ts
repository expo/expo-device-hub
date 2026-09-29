/** Wait through the server's stale-socket expiry window before reporting 1013. */
export function createInputSocketRetryNotice(
  report: (reason: string) => void,
  delayMs = 13_000,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let admitted = false;
  let notified = false;
  let disposed = false;

  return {
    connecting() { admitted = false; },
    admitted() {
      admitted = true;
      if (timer) clearTimeout(timer);
      timer = null;
      notified = false;
    },
    rejected(reason: string) {
      if (disposed || timer || notified) return;
      timer = setTimeout(() => {
        timer = null;
        if (!disposed && !admitted) {
          notified = true;
          report(reason);
        }
      }, delayMs);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
