export interface ExecWsEventBlock {
  event: string;
  data: string;
}

export interface ExecWsEventSubscription {
  close(): void;
}

type Subscription = {
  path: string;
  onBlock: (block: ExecWsEventBlock) => void;
  onInterrupted?: () => void;
  wireId: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  buffer: string;
  closed: boolean;
};

/** Append raw SSE bytes and emit every complete block, retaining a partial tail. */
function drainSseChunk(
  previous: string,
  chunk: string,
  emit: (block: ExecWsEventBlock) => void,
): string {
  let buffer = `${previous}${chunk}`.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let boundary: number;
  while ((boundary = buffer.indexOf('\n\n')) !== -1) {
    const lines = buffer.slice(0, boundary).split('\n');
    buffer = buffer.slice(boundary + 2);
    const event =
      lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim() || 'message';
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) emit({ event, data });
  }
  return buffer;
}

/**
 * One authenticated exec-ws connection shared by independent SSE subscriptions.
 * A stream end retries only that stream; a socket interruption reconnects every
 * still-active stream. Closing one subscription never closes its siblings.
 */
export class ExecWsEventPool {
  private socket: WebSocket | null = null;
  private ready = false;
  private nextWireId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscriptions = new Set<Subscription>();
  private readonly subscriptionsByWireId = new Map<number, Subscription>();

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly retryMs: number,
  ) {}

  subscribe(
    path: string,
    onBlock: (block: ExecWsEventBlock) => void,
    onInterrupted?: () => void,
  ): ExecWsEventSubscription {
    const subscription: Subscription = {
      path,
      onBlock,
      onInterrupted,
      wireId: null,
      retryTimer: null,
      buffer: '',
      closed: false,
    };
    this.subscriptions.add(subscription);
    this.ensureConnected();
    if (this.ready) this.startSubscription(subscription);

    return {
      close: () => this.closeSubscription(subscription),
    };
  }

  private closeSubscription(subscription: Subscription) {
    if (subscription.closed) return;
    subscription.closed = true;
    this.subscriptions.delete(subscription);
    if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
    subscription.retryTimer = null;
    if (subscription.wireId !== null) {
      this.subscriptionsByWireId.delete(subscription.wireId);
      this.send({ unsub: subscription.wireId });
      subscription.wireId = null;
    }
    if (this.subscriptions.size === 0) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const socket = this.socket;
      this.socket = null;
      this.ready = false;
      try {
        socket?.close();
      } catch {}
    }
  }

  private ensureConnected() {
    if (this.socket || this.subscriptions.size === 0) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.markAllInterrupted();
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket === socket) socket.send(JSON.stringify({ token: this.token }));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let message: { ready?: boolean; sub?: number; data?: string; end?: boolean };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.ready) {
        this.ready = true;
        for (const subscription of this.subscriptions) this.startSubscription(subscription);
        return;
      }
      if (typeof message.sub !== 'number') return;
      const subscription = this.subscriptionsByWireId.get(message.sub);
      if (!subscription) return;
      if (message.end) {
        this.subscriptionsByWireId.delete(message.sub);
        subscription.wireId = null;
        subscription.buffer = '';
        subscription.onInterrupted?.();
        this.scheduleSubscriptionRetry(subscription);
        return;
      }
      if (typeof message.data === 'string') {
        subscription.buffer = drainSseChunk(
          subscription.buffer,
          message.data,
          subscription.onBlock,
        );
      }
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.subscriptionsByWireId.clear();
      this.markAllInterrupted();
      for (const subscription of this.subscriptions) {
        subscription.wireId = null;
        subscription.buffer = '';
      }
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {}
    };
  }

  private startSubscription(subscription: Subscription) {
    if (subscription.closed || subscription.wireId !== null || !this.ready) return;
    if (subscription.retryTimer) clearTimeout(subscription.retryTimer);
    subscription.retryTimer = null;
    subscription.buffer = '';
    subscription.wireId = this.nextWireId++;
    this.subscriptionsByWireId.set(subscription.wireId, subscription);
    this.send({ sub: subscription.wireId, path: subscription.path });
  }

  private scheduleSubscriptionRetry(subscription: Subscription) {
    if (subscription.closed || subscription.retryTimer) return;
    subscription.retryTimer = setTimeout(() => {
      subscription.retryTimer = null;
      if (!subscription.closed) this.startSubscription(subscription);
    }, this.retryMs);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.subscriptions.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, this.retryMs);
  }

  private markAllInterrupted() {
    for (const subscription of this.subscriptions) subscription.onInterrupted?.();
  }

  private send(message: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
