import type { IncomingMessage, ServerResponse } from "node:http";

const SSE_HEARTBEAT_MS = 15_000;

export interface SseStream {
  isOpen: () => boolean;
  write: (payload: string) => void;
  onClose: (teardown: () => void) => void;
}

/** `isOpen` is the `writableEnded`/`destroyed` pair: an aborted client only sets the latter. */
export function openSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { onHeartbeat?: () => void } = {}
): SseStream {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");

  let closed = false;
  const isOpen = (): boolean => !closed && !res.writableEnded && !res.destroyed;
  const heartbeat = setInterval(() => {
    if (!isOpen()) return;
    opts.onHeartbeat?.();
    res.write(":\n\n");
  }, SSE_HEARTBEAT_MS);
  const teardowns: (() => void)[] = [];
  const closeAll = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    req.off("close", closeAll);
    res.off?.("close", closeAll);
    while (teardowns.length > 0) {
      try { teardowns.pop()!(); } catch {}
    }
  };
  req.on("close", closeAll);
  res.on?.("close", closeAll);
  // A client that left during the caller's await already fired `close`, so run teardown now.
  if (req.destroyed || res.destroyed || res.writableEnded) closeAll();

  return {
    isOpen,
    write: (payload) => {
      if (isOpen()) res.write(payload);
    },
    onClose: (teardown) => (closed ? teardown() : teardowns.push(teardown)),
  };
}
