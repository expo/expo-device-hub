import { EXEC_WS_MAX_MESSAGE_BYTES } from "./control-utils";
import type { Socket } from "net";
import type { HidSocket } from "../device-session";
import { HID_HEARTBEAT, createSocketHeartbeat } from "./heartbeat";
import { parseWebSocketFrame, sendBrowserFrame, websocketFrame } from "./frames";
import type { UpgradeHandlerWebSocket } from "./types";

/** Detect a stranded host-accepted HID socket even when its proxy never forwards a close. */
export function heartbeatHidSocket(
  websocket: UpgradeHandlerWebSocket,
  heartbeat = HID_HEARTBEAT,
): UpgradeHandlerWebSocket {
  let closed = false;
  let stopHeartbeat = () => {};
  const closeListeners: Array<() => void> = [];
  const fireClose = () => {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    for (const listener of closeListeners) listener();
  };
  const shutdown = () => {
    fireClose();
    try {
      if (websocket.terminate) websocket.terminate();
      else websocket.close();
    } catch { /* The socket is already detached from the session. */ }
  };
  const monitor = createSocketHeartbeat(() => websocket.ping!(), shutdown, heartbeat);
  stopHeartbeat = monitor.stop;
  websocket.on("pong", monitor.pong);
  websocket.on("close", fireClose);
  websocket.on("error", fireClose);
  monitor.start();
  return {
    OPEN: websocket.OPEN,
    get readyState() { return websocket.readyState; },
    send: (data) => websocket.send(data),
    close: (code?: number, reason?: string) => { fireClose(); websocket.close(code, reason); },
    on(event: "message" | "close" | "error" | "pong", listener: ((data: Buffer<ArrayBufferLike>) => void) | (() => void)) {
      if (event === "close" || event === "error") {
        if (closed) (listener as () => void)();
        else closeListeners.push(listener as () => void);
      } else websocket.on(event as "message", listener as (data: Buffer<ArrayBufferLike>) => void);
    },
  };
}

export function isHidWebSocketPath(upstreamPath: string): boolean {
  return new URL(upstreamPath, "http://serve-sim.local").pathname === "/ws";
}

export function claimHelperHidSocket(
  request: Request,
  websocket: UpgradeHandlerWebSocket,
  { helperProxyTarget, fallbackDevice, resolveSession }: {
    helperProxyTarget(rawUrl: string): { device: string | null; upstreamPath: string } | null;
    fallbackDevice: string | null;
    resolveSession: {
      (device: string): { attachHidSocket(ws: UpgradeHandlerWebSocket): void };
    };
  },
  heartbeat = HID_HEARTBEAT,
): boolean {
  const url = new URL(request.url, "http://serve-sim.local");
  const target = helperProxyTarget(`${url.pathname}${url.search}`);
  if (!target || !isHidWebSocketPath(target.upstreamPath)) return false;
  const device = target.device ?? fallbackDevice ?? null;
  if (!device) {
    websocket.close();
    return true;
  }
  let session: { attachHidSocket(ws: UpgradeHandlerWebSocket): void };
  try {
    session = resolveSession(device);
  } catch {
    websocket.close(); // not booted / capture unavailable
    return true;
  }
  // Known host integrations use `ws` sockets. Preserve input on a host without
  // protocol ping support, though it cannot detect a stranded connection here.
  session.attachHidSocket(
    typeof websocket.ping === "function" ? heartbeatHidSocket(websocket, heartbeat) : websocket,
  );
  return true;
}

/** Adapt a raw upgraded socket for DeviceSession when `ws` cannot flush the server handshake under Bun. */
export function rawHidSocket(
  socket: Socket,
  head: Buffer,
  heartbeat = HID_HEARTBEAT,
): HidSocket {
  const messageCbs: Array<(d: Buffer) => void> = [];
  const closeCbs: Array<() => void> = [];
  let buffered = Buffer.from(head);
  let closed = false;
  let stopHeartbeat = () => {};
  let receivedPong = () => {};
  let forceClose: ReturnType<typeof setTimeout> | undefined;

  const fireClose = () => {
    if (closed) return;
    closed = true;
    buffered = Buffer.alloc(0);
    stopHeartbeat();
    for (const cb of closeCbs) cb();
  };
  const shutdown = (code?: number, reason = "") => {
    if (closed) return;
    fireClose();
    // @ref LLP 0003#raw-hid-close-contract — flush close frames without retaining input capacity.
    forceClose = setTimeout(() => socket.destroy(), 1_000);
    forceClose.unref?.();
    const payload = code === undefined ? Buffer.alloc(0) : Buffer.alloc(2 + Buffer.byteLength(reason));
    if (code !== undefined) {
      payload.writeUInt16BE(code);
      payload.write(reason, 2);
    }
    try {
      socket.end(websocketFrame(0x8, payload));
    } catch { socket.destroy(); }
  };

  const drain = () => {
    if (closed) return;
    for (;;) {
      let frame;
      try {
        frame = parseWebSocketFrame(buffered, EXEC_WS_MAX_MESSAGE_BYTES);
      } catch {
        shutdown();
        return;
      }
      if (!frame) return;
      buffered = buffered.subarray(frame.consumed);
      if (frame.opcode === 0x8) return shutdown();
      if (frame.opcode === 0x9) { sendBrowserFrame(socket, 0xa, frame.payload); continue; }
      if (frame.opcode === 0xa) { receivedPong(); continue; }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        for (const cb of messageCbs) cb(frame.payload);
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffered = Buffer.concat([buffered, chunk]);
    drain();
  });
  socket.on("close", () => {
    clearTimeout(forceClose);
    forceClose = undefined;
    fireClose();
  });
  socket.on("error", fireClose);
  if (head.length) drain();
  if (!closed) {
    const monitor = createSocketHeartbeat(() => sendBrowserFrame(socket, 0x9), shutdown, heartbeat);
    stopHeartbeat = monitor.stop;
    receivedPong = monitor.pong;
    monitor.start();
  }

  return {
    send(data: Buffer) { sendBrowserFrame(socket, 0x2, data); },
    on(event: "message" | "close" | "error", cb: (data: Buffer) => void) {
      if (event === "message") messageCbs.push(cb);
      else if (closed) (cb as () => void)();
      else closeCbs.push(cb as () => void);
    },
    close: shutdown,
  };
}
