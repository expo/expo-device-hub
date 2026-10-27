import { DEFAULT_EXEC_MAX_QUEUED, ExecError, type ExecClock } from "./exec.ts";

const WRITE_WAIT_TIMEOUT_MS = 10_000;
const SYSTEM_CLOCK: ExecClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createPermissionRequestQueue(clock: ExecClock = SYSTEM_CLOCK) {
  const requests = new Map<string, Promise<unknown>>();
  let pending = 0;

  return function runPermissionRequest<T>(
    serial: string,
    pkg: string,
    operation: () => Promise<T>,
    kind: "read" | "write" = "write",
  ): Promise<T> {
    // @ref LLP 0013#app-permissions — a recovery read must wait for earlier writes, even after HTTP disconnects
    if (pending >= DEFAULT_EXEC_MAX_QUEUED) {
      return Promise.reject(new ExecError("queue-full", "permission request queue is full"));
    }
    const key = JSON.stringify([serial, pkg]);
    const previous = requests.get(key) ?? Promise.resolve();
    pending++;
    const deadline = kind === "write" ? clock.now() + WRITE_WAIT_TIMEOUT_MS : Infinity;
    const timeoutError = new ExecError(
      "deadline-exceeded",
      "permission request timed out waiting after 10000ms",
    );
    let expired = false;
    let timer: unknown;
    const waiting =
      kind === "write"
        ? new Promise<never>((_, reject) => {
            timer = clock.setTimeout(() => {
              expired = true;
              reject(timeoutError);
            }, WRITE_WAIT_TIMEOUT_MS);
          })
        : null;
    const current = previous
      .catch(() => {})
      .then(() => {
        if (timer !== undefined) clock.clearTimeout(timer);
        if (expired || clock.now() >= deadline) throw timeoutError;
        return operation();
      })
      .finally(() => {
        pending--;
        if (requests.get(key) === current) requests.delete(key);
      });
    requests.set(key, current);
    // Keep the tail until earlier work finishes; timing out a caller must not let later work overtake it.
    return waiting ? Promise.race([current, waiting]) : current;
  };
}

export const runPermissionRequest = createPermissionRequestQueue();
