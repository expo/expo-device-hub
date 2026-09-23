import {
  messageToString,
  requestHost,
  type SseRequestHandler,
} from "./exec-ws-utils";
import { type UpgradeHandlerWebSocket } from "./middleware-utils";
import { InvalidHostActionError, runHostActionAsync } from "./host-actions";
import { safeEqualString } from "./session-auth";

// WebSocket control channel for the preview page. Browsers cap HTTP/1.1 at
// six connections per origin, and every preview tab used to hold several
// long-lived requests (MJPEG + 3-4 SSE channels + pooled exec fetches) — with
// two or more tabs open, new requests queue behind them forever. This channel
// carries typed simulator actions, simulator-settings requests, and multiplexed SSE
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
//   client → {id, action, params}      run one typed simulator action
//   server → {id, stdout, stderr, exitCode}
//   client → {id, ui:{…}}             simulator-settings request (in-process,
//   server → {id, …} | {id, error}     no shell round-trip)
//   client → {sub, path}              subscribe to a same-origin SSE route
//   server → {sub, data}              raw SSE bytes for that subscription
//   server → {sub, end:true}          upstream closed
//   client → {unsub: sub}             cancel a subscription

const AUTH_TIMEOUT_MS = 10_000;
// A shareable link must not spawn unbounded work: a subscription holds a stream or watcher and an
// action spawns a process, so both are capped per socket.
const MAX_SUBSCRIPTIONS_PER_SOCKET = 16;
const MAX_ACTIONS_IN_FLIGHT_PER_SOCKET = 8;

interface ExecMessage {
  token?: string;
  id?: number;
  action?: string;
  params?: unknown;
  ui?: unknown;
  sub?: number;
  path?: string;
  unsub?: number;
}

/** In-process handler for `{id, ui}` requests; resolves to the reply body. */
export type UiRequestHandler = (payload: unknown) => Promise<Record<string, unknown>>;
export type ActionResultHandler = (
  action: string,
  params: Record<string, unknown> | undefined,
  result: { stdout: string; stderr: string; exitCode: number },
) => void;

interface ExecChannelOptions {
  path: string;
  execToken: string;
  /** Exact pathnames (query excluded) the channel may proxy as SSE. */
  ssePrefixes?: string[];
  /** In-process handler for `{id, ui}` simulator-settings requests. */
  onUiRequest?: UiRequestHandler;
  onActionResult?: ActionResultHandler;
  /** Routes an authenticated subscription back through the owning middleware. */
  onSseRequest?: SseRequestHandler;
  serveSimBinPath?: string;
}

function wireExecSocket(
  ws: UpgradeHandlerWebSocket,
  request: Request,
  opts: ExecChannelOptions,
): void {
  let authed = false;
  const subscriptions = new Map<number, { destroy: () => void }>();
  let actionsInFlight = 0;
  // A ui request spawns simctl or ax just as an action does, so both draw on the same ceiling.
  const reserveAction = (id: unknown): boolean => {
    if (actionsInFlight >= MAX_ACTIONS_IN_FLIGHT_PER_SOCKET) {
      send({ id, error: "too many actions in flight on this connection" });
      return false;
    }
    actionsInFlight += 1;
    return true;
  };
  const ssePrefixes = opts.ssePrefixes ?? [];

  const send = (value: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(value));
  };

  const authTimer = setTimeout(() => {
    if (!authed) ws.close();
  }, AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  const subscribe = (sub: number, path: string) => {
    // Every other refusal answers; a silent one leaves the client's subscription pending forever.
    if (subscriptions.has(sub)) {
      send({ sub, end: true, error: "subscription id already in use on this connection" });
      return;
    }
    if (subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
      send({ sub, end: true, error: "too many subscriptions on this connection" });
      return;
    }
    // Only this middleware's own SSE routes, and only for an authed socket.
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
        const response = await opts.onSseRequest!(path, request);
        if (!active) {
          // `reader` was never taken, and cancelling the body is the only thing that tells the
          // route to tear down: a subrequest here has no socket whose close it could notice.
          void response?.body?.cancel().catch(() => {});
          return;
        }
        if (!response?.body) {
          sendEnd();
          return;
        }
        const textDecoder = new TextDecoder();
        reader = response.body.getReader();
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          send({ sub, data: textDecoder.decode(value, { stream: true }) });
        }

        // Flush bytes held back mid-multibyte-sequence when the stream ends.
        if (active) {
          const tail = textDecoder.decode();
          if (tail) send({ sub, data: tail });
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
      if (typeof msg.token === "string" && safeEqualString(msg.token, opts.execToken)) {
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
      if (!reserveAction(id)) return;
      opts
        .onUiRequest(msg.ui)
        .then((reply) => send({ id, ...reply }))
        .catch((e: unknown) => send({ id, error: e instanceof Error ? e.message : String(e) }))
        .finally(() => {
          actionsInFlight -= 1;
        });
      return;
    }
    if (typeof msg.id !== "number") {
      return;
    }
    if (typeof msg.action !== "string") {
      // The client keeps a pending promise per id with no timeout, so an unanswered frame hangs it.
      send({ id: msg.id, error: "unsupported request" });
      return;
    }
    const { id, action } = msg;
    if (!reserveAction(id)) return;
    const params = msg.params as Record<string, unknown> | undefined;
    runHostActionAsync(msg, opts.serveSimBinPath ?? "serve-sim")
      .then((result) => {
        try {
          opts.onActionResult?.(action, params, result);
        } catch {
          // Diagnostic side-channel; a failure here must not break the reply.
        }
        send({ id, ...result });
      })
      .catch((e: unknown) => {
        if (!(e instanceof InvalidHostActionError)) {
          console.error(`serve-sim action ${action} failed:`, e);
        }
        send({ id, error: e instanceof InvalidHostActionError ? e.message : "action failed" });
      })
      .finally(() => {
        actionsInFlight -= 1;
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
  return function handleWebSocket(request: Request, websocket: UpgradeHandlerWebSocket): boolean {
    const url = new URL(request.url);
    if (url.pathname !== opts.path && url.pathname !== `${opts.path}/`) return false;

    // Browsers always send Origin on upgrades, so this keeps another site's page off the channel.
    const origin = request.headers.get("origin");
    if (origin) {
      try {
        if (new URL(origin).host !== requestHost(request)) {
          websocket.close();
          return true;
        }
      } catch {
        websocket.close();
        return true;
      }
    }

    wireExecSocket(websocket, request, opts);
    return true;
  };
}
