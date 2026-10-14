type Reply = { requestId?: unknown; ok?: unknown; error?: unknown };
type PendingBarrier = {
  connection: object;
  timeout: ReturnType<typeof setTimeout>;
  resolve(): void;
  reject(error: Error): void;
};

/** Correlate input acknowledgments across timeouts and reconnects. */
export function createInputBarriers(
  send: (connection: object, requestId: number) => boolean,
  timeoutMs = 150_000,
) {
  let nextRequestId = 0;
  const pending = new Map<number, PendingBarrier>();
  const disconnected = () => new Error("Simulator input disconnected during copy");

  return {
    wait(connection: object | null | undefined): Promise<void> {
      if (!connection) return Promise.reject(disconnected());
      return new Promise<void>((resolve, reject) => {
        const requestId = ++nextRequestId;
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("Simulator input did not finish in time"));
        }, timeoutMs);
        pending.set(requestId, { connection, timeout, resolve, reject });
        if (!send(connection, requestId)) {
          clearTimeout(timeout);
          pending.delete(requestId);
          reject(disconnected());
        }
      });
    },
    receive(connection: object | null, value: unknown): boolean {
      if (!value || typeof value !== "object") return false;
      const reply = value as Reply;
      if (typeof reply.requestId !== "number" || typeof reply.ok !== "boolean") return false;
      const barrier = pending.get(reply.requestId);
      if (!barrier || barrier.connection !== connection) return false;
      clearTimeout(barrier.timeout);
      pending.delete(reply.requestId);
      if (reply.ok) barrier.resolve();
      else barrier.reject(new Error(typeof reply.error === "string"
        ? reply.error : "Simulator input failed. Reload the preview and retry."));
      return true;
    },
    cancel(): void {
      for (const barrier of pending.values()) {
        clearTimeout(barrier.timeout);
        barrier.reject(disconnected());
      }
      pending.clear();
    },
  };
}
