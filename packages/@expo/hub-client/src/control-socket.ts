/** A control channel belongs to one client identity, never to the module. */
export function createControlSocket(
  url: string,
  token: string,
  {
    openSocket = (address: string) => new WebSocket(address),
    connectTimeoutMs = 5_000,
    retryMs = 2_000,
    healthIntervalMs = 5_000,
    healthTimeoutMs = 5_000,
  } = {},
) {
  type Reply = Record<string, unknown>;
  type Pending = { body: Reply; sent: boolean; finish: (error?: Error, reply?: Reply) => void };
  type Subscription = {
    path: string;
    data: (chunk: string) => void;
    end: () => void;
    timer?: ReturnType<typeof setTimeout>;
  };
  let socket: WebSocket | null = null;
  let ready = false;
  let disposed = false;
  let nextId = 1;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let healthProbeId: number | undefined;
  const pending = new Map<number, Pending>();
  const subscriptions = new Map<number, Subscription>();

  const clearHealth = () => {
    clearTimeout(healthTimer);
    healthTimer = undefined;
    healthProbeId = undefined;
  };

  const notifyEnd = (sub: Subscription) => {
    try {
      sub.end();
    } catch {}
  };
  const fail = (ws: WebSocket | null, error: Error) => {
    if (disposed || socket !== ws) return;
    socket = null;
    ready = false;
    clearTimeout(connectTimer);
    clearHealth();
    for (const request of [...pending.values()]) request.finish(error);
    for (const sub of subscriptions.values()) {
      clearTimeout(sub.timer);
      sub.timer = undefined;
      notifyEnd(sub);
    }
    try {
      ws?.close();
    } catch {}
    if (subscriptions.size && retryTimer === undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, retryMs);
    }
  };
  const send = (ws: WebSocket, body: Reply) => {
    try {
      ws.send(JSON.stringify(body));
    } catch {
      fail(ws, new Error("exec-ws error"));
    }
  };
  const scheduleHealthCheck = (ws: WebSocket) => {
    if (disposed || socket !== ws || !ready) return;
    healthTimer = setTimeout(() => {
      if (disposed || socket !== ws || !ready) return;
      healthProbeId = nextId++;
      // An id-only exec request gets an immediate "unsupported request" reply
      // before host action dispatch, including on older serve-sim servers.
      // Probe the channel independently of potentially slow host actions.
      healthTimer = setTimeout(() => fail(ws, new Error("exec-ws timeout")), healthTimeoutMs);
      send(ws, { id: healthProbeId });
    }, healthIntervalMs);
  };
  const sendSubscription = (id: number, sub: Subscription) => {
    if (ready && socket) send(socket, { sub: id, path: sub.path });
  };
  const connect = () => {
    if (disposed || socket) return;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    let ws: WebSocket;
    try {
      ws = openSocket(url);
    } catch {
      fail(null, new Error("exec-ws error"));
      return;
    }
    socket = ws;
    connectTimer = setTimeout(() => fail(ws, new Error("exec-ws timeout")), connectTimeoutMs);
    ws.onopen = () => {
      if (!disposed && socket === ws) send(ws, { token });
    };
    ws.onmessage = (event) => {
      if (disposed || socket !== ws) return;
      let msg: Reply;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.ready === true) {
        if (ready) return;
        ready = true;
        clearTimeout(connectTimer);
        scheduleHealthCheck(ws);
        for (const [id, request] of pending) {
          if (socket !== ws) break;
          request.sent = true;
          send(ws, { ...request.body, id });
        }
        for (const [id, sub] of subscriptions) {
          if (socket !== ws) break;
          sendSubscription(id, sub);
        }
        return;
      }
      if (!ready) return;
      if (typeof msg.id === "number") {
        if (msg.id === healthProbeId) {
          clearHealth();
          scheduleHealthCheck(ws);
          return;
        }
        const request = pending.get(msg.id);
        if (request?.sent)
          request.finish(typeof msg.error === "string" ? new Error(msg.error) : undefined, msg);
      } else if (typeof msg.sub === "number") {
        const id = msg.sub;
        const sub = subscriptions.get(id);
        if (!sub) return;
        if (msg.end === true) {
          notifyEnd(sub);
          if (sub.timer === undefined)
            sub.timer = setTimeout(() => {
              sub.timer = undefined;
              if (!disposed && subscriptions.get(id) === sub) sendSubscription(id, sub);
            }, retryMs);
        } else if (typeof msg.data === "string") sub.data(msg.data);
      }
    };
    ws.onclose = () => fail(ws, new Error("exec-ws closed"));
    ws.onerror = () => fail(ws, new Error("exec-ws error"));
  };

  return {
    request(body: Reply, timeoutMs: number, signal?: AbortSignal): Promise<Reply> {
      return new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error("exec-ws closed"));
          return;
        }
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const id = nextId++;
        let settled = false;
        const finish = (error?: Error, reply?: Reply) => {
          if (settled) return;
          settled = true;
          pending.delete(id);
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve(reply ?? {});
        };
        const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        const timer = setTimeout(() => finish(new Error("exec-ws timeout")), timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        pending.set(id, { body, sent: false, finish });
        if (ready && socket) {
          pending.get(id)!.sent = true;
          send(socket, { ...body, id });
        } else connect();
      });
    },
    subscribe(path: string, data: (chunk: string) => void, end: () => void) {
      if (disposed) return () => {};
      const id = nextId++;
      const sub: Subscription = { path, data, end };
      subscriptions.set(id, sub);
      if (ready) sendSubscription(id, sub);
      else connect();
      return () => {
        if (subscriptions.get(id) !== sub) return;
        subscriptions.delete(id);
        clearTimeout(sub.timer);
        if (ready && socket) send(socket, { unsub: id });
        if (!subscriptions.size) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
      };
    },
    /** React may replay an effect for this same identity after its cleanup. */
    activate() {
      disposed = false;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(connectTimer);
      clearTimeout(retryTimer);
      clearHealth();
      for (const request of [...pending.values()]) request.finish(new Error("exec-ws closed"));
      for (const sub of subscriptions.values()) clearTimeout(sub.timer);
      subscriptions.clear();
      const ws = socket;
      socket = null;
      ready = false;
      try {
        ws?.close();
      } catch {}
    },
  };
}

export type ControlSocket = ReturnType<typeof createControlSocket>;
