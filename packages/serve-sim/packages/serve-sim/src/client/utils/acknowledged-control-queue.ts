export type AcknowledgedControlRequest<T extends object> = {
  requestId: number;
  command: T;
};

export type AcknowledgedControlReply = {
  requestId: number;
  ok: boolean;
  error?: string;
};

type QueueOptions<T extends object> = {
  send(request: AcknowledgedControlRequest<T>): boolean;
  onPendingChange?(pending: boolean): void;
  onResult?(command: T, reply: AcknowledgedControlReply): void;
  onError?(message: string, command: T): void;
  timeoutMs?: number;
};

type EnqueueOptions = {
  key: string;
  replaceQueued?: boolean;
};

/** Keeps live controls responsive without sending another command before its acknowledgement. */
export function createAcknowledgedControlQueue<T extends object>(options: QueueOptions<T>) {
  const queued: { key: string; command: T }[] = [];
  let active: AcknowledgedControlRequest<T> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextRequestId = 1;
  let pending = false;

  function setPending(value: boolean) {
    if (pending === value) return;
    pending = value;
    options.onPendingChange?.(value);
  }

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function clear() {
    clearTimer();
    active = undefined;
    queued.length = 0;
    setPending(false);
  }

  function fail(message: string, command: T) {
    clear();
    options.onError?.(message, command);
  }

  function sendNext() {
    if (active) return;
    const next = queued.shift();
    if (!next) {
      setPending(false);
      return;
    }

    const request = { requestId: nextRequestId++, command: next.command };
    active = request;
    setPending(true);
    timer = setTimeout(() => {
      if (active?.requestId === request.requestId) {
        fail("Device control timed out.", request.command);
      }
    }, options.timeoutMs ?? 5_000);
    if (!options.send(request)) fail("Device is disconnected.", request.command);
  }

  return {
    enqueue(command: T, { key, replaceQueued }: EnqueueOptions) {
      if (replaceQueued) queued.length = 0;
      const existing = queued.findIndex((entry) => entry.key === key);
      if (existing >= 0) {
        queued[existing] = { key, command };
      } else {
        queued.push({ key, command });
      }
      sendNext();
    },

    receive(reply: AcknowledgedControlReply): boolean {
      if (!active || reply.requestId !== active.requestId) return false;
      const { command } = active;
      clearTimer();
      active = undefined;
      options.onResult?.(command, reply);
      if (reply.ok) {
        sendNext();
      } else {
        fail(reply.error || "Device control failed.", command);
      }
      return true;
    },

    // Keep request IDs increasing so replies from a previous device cannot match new work.
    clear,
  };
}
