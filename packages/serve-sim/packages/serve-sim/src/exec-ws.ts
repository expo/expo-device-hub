import { exec, type ExecException } from "child_process";
import { createHash, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries shell execs, simulator-settings requests, and multiplexed SSE
// subscriptions, so each tab needs just one pooled connection (the video
// stream) plus this socket.
//
// The middleware owns the protocol below, but not the HTTP upgrade. Hosts pass
// an already-accepted websocket into `handleWebSocket`; the bundled Node
// runtime does that with `ws`, while other web runtimes can provide their own
// socket object with the same small shape.
//
// Wire protocol (all JSON text frames):
//   client → {token}                  first frame; must match the exec token
//   server → {ready:true}             auth accepted
//   client → {id, command}            run a shell command
//   server → {id, stdout, stderr, exitCode}
//   client → {id, ui:{…}}             simulator-settings request (in-process,
//   server → {id, …} | {id, error}     no shell round-trip)
//   client → {sub, path}              subscribe to a same-origin SSE route
//   server → {sub, data}              raw SSE bytes for that subscription
//   server → {sub, end:true}          upstream closed
//   client → {unsub: sub}             cancel a subscription

const AUTH_TIMEOUT_MS = 10_000;
export const EXEC_WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const textDecoder = new TextDecoder();

export interface ExecWebSocket {
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error?: unknown) => void): void;
  on(event: "close", listener: () => void): void;
}

function tokensMatch(a: string, b: string): boolean {
  // Hash both sides so the comparison is constant-time even when lengths differ.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

interface ExecMessage {
  token?: string;
  id?: number;
  command?: string;
  ui?: unknown;
  sub?: number;
  path?: string;
  unsub?: number;
}

/** In-process handler for `{id, ui}` requests; resolves to the reply body. */
export type UiRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;

type SseRequestHandler = (
  path: string,
  websocketRequest: IncomingMessage,
) => Response | undefined | Promise<Response | undefined>;

interface ExecChannelOptions {
  path: string;
  execToken: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
  /** Routes an authenticated subscription back through the owning middleware. */
  onSseRequest?: SseRequestHandler;
}

function messageToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return textDecoder.decode(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return textDecoder.decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

function requestHost(req: IncomingMessage): string {
  return req.headers.host ?? "";
}

function wireExecSocket(
  ws: ExecWebSocket,
  req: IncomingMessage,
  opts: ExecChannelOptions,
): void {
  let authed = false;
  const subscriptions = new Map<number, { destroy: () => void }>();
  const ssePrefixes = opts.ssePrefixes ?? [];

  const send = (value: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };

  const authTimer = setTimeout(() => {
    if (!authed) ws.close();
  }, AUTH_TIMEOUT_MS);
  (authTimer as { unref?: () => void }).unref?.();

  const subscribe = (sub: number, path: string) => {
    if (subscriptions.has(sub)) return;
    // Only same-origin SSE routes owned by this middleware are reachable, and
    // only for authed sockets — strictly less exposure than the routes' own
    // direct (tokenless same-origin) GET surface.
    const pathOnly = path.split("?")[0]!;
    if (!path.startsWith("/") || !ssePrefixes.some((p) => pathOnly === p)) {
      send({ sub, end: true, error: "path not allowed" });
      return;
    }
    if (!opts.onSseRequest) {
      send({ sub, end: true, error: "sse requests not supported" });
      return;
    }

    let active = true;
    let endSent = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const sendEnd = (error?: string) => {
      if (endSent) return;
      endSent = true;
      send(error ? { sub, end: true, error } : { sub, end: true });
    };
    const subscription = {
      destroy() {
        active = false;
        void reader?.cancel().catch(() => {});
      },
    };
    subscriptions.set(sub, subscription);

    void (async () => {
      try {
        const response = await opts.onSseRequest!(path, req);
        if (!active) return;
        if (!response?.body) {
          sendEnd();
          return;
        }
        reader = response.body.getReader();
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          send({ sub, data: textDecoder.decode(value, { stream: true }) });
        }
      } catch {
        if (active) sendEnd();
        return;
      } finally {
        active = false;
        if (reader) {
          try { reader.releaseLock(); } catch {}
        }
        if (subscriptions.get(sub) === subscription) {
          subscriptions.delete(sub);
          sendEnd();
        }
      }
    })();
  };

  ws.on("message", (data) => {
    let msg: ExecMessage;
    try {
      msg = JSON.parse(messageToString(data)) as ExecMessage;
    } catch {
      return;
    }
    if (!authed) {
      if (typeof msg.token === "string" && tokensMatch(msg.token, opts.execToken)) {
        authed = true;
        clearTimeout(authTimer);
        send({ ready: true });
      } else {
        ws.close();
      }
      return;
    }
    if (typeof msg.unsub === "number") {
      subscriptions.get(msg.unsub)?.destroy();
      subscriptions.delete(msg.unsub);
      return;
    }
    if (typeof msg.sub === "number" && typeof msg.path === "string") {
      subscribe(msg.sub, msg.path);
      return;
    }
    if (typeof msg.id === "number" && msg.ui !== undefined) {
      const { id } = msg;
      if (!opts.onUiRequest) {
        send({ id, error: "ui requests not supported" });
        return;
      }
      opts
        .onUiRequest(msg.ui)
        .then((reply) => send({ id, ...reply }))
        .catch((e: unknown) =>
          send({ id, error: e instanceof Error ? e.message : String(e) }),
        );
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.command !== "string" || !msg.command) {
      return;
    }
    const { id, command } = msg;
    exec(command, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      send({
        id,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: err ? ((err as ExecException).code ?? 1) : 0,
      });
    });
  });

  ws.on("error", () => ws.close());
  ws.on("close", () => {
    clearTimeout(authTimer);
    for (const sub of subscriptions.values()) sub.destroy();
    subscriptions.clear();
  });
}

/**
 * Websocket handler for `<basePath>/exec-ws`. Returns true when the request was
 * for the exec channel, false when the caller should close or route it.
 */
export function createExecWebSocketHandler(opts: ExecChannelOptions) {
  // NOTE(expo-cli): this takes the raw Node `IncomingMessage` from the `upgrade`
  // event rather than a web `Request`. An `upgrade` has no paired
  // `ServerResponse`, so the host can't build a `Request` via
  // `convertRequest`/`createRequestListener` (their abort wiring needs the
  // response). When this exec channel is upstreamed into the Expo CLI, the
  // CLI's upgrade handling should be updated to pass the `IncomingMessage`
  // through here the same way instead of synthesizing a `Request`.
  return function handleWebSocket(req: IncomingMessage, websocket: ExecWebSocket): boolean {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== opts.path && url.pathname !== `${opts.path}/`) return false;

    // Same-origin policy mirrors POST /exec: browsers always send Origin on
    // WebSocket upgrades, and a cross-origin page's Origin won't match Host.
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== requestHost(req)) {
          websocket.close();
          return true;
        }
      } catch {
        websocket.close();
        return true;
      }
    }

    wireExecSocket(websocket, req, opts);
    return true;
  };
}
