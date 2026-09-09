import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";
import type { Socket } from "net";

type Next = (error?: unknown) => void | Promise<void>;

export type ConnectMiddleware = {
  (req: IncomingMessage, res: ServerResponse, next?: Next): void | Promise<void>;
  handleUpgrade?: (req: IncomingMessage, socket: Socket, head: Buffer) => void;
};

function headersFromRequest(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  if (!headers.host) headers.host = new URL(request.url).host;
  return headers;
}

/** Adapt the package's Connect-style implementation to its public Fetch handler. */
export function connectToFetch(
  handler: ConnectMiddleware,
  request: Request,
): Promise<Response | undefined> {
  const requestUrl = new URL(request.url);
  const requestEvents = new EventEmitter();
  const responseEvents = new EventEmitter();
  const abortController = new AbortController();
  let requestBodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let requestClosed = false;
  const closeRequest = (aborted = false) => {
    if (requestClosed) return;
    requestClosed = true;
    abortController.abort();
    void requestBodyReader?.cancel().catch(() => {});
    request.signal.removeEventListener("abort", handleRequestAbort);
    if (aborted) requestEvents.emit("aborted");
    requestEvents.emit("close");
  };
  const handleRequestAbort = () => closeRequest(true);
  const requestWasAlreadyAborted = request.signal.aborted;
  request.signal.addEventListener("abort", handleRequestAbort, { once: true });
  const fakeReq = Object.assign(requestEvents, {
    method: request.method,
    url: `${requestUrl.pathname}${requestUrl.search}`,
    headers: headersFromRequest(request),
    socket: { localPort: Number(requestUrl.port) || undefined },
    destroy() {
      closeRequest();
    },
  }) as IncomingMessage;

  let status = 200;
  let responseHeaders = new Headers();
  let headersSent = false;
  let writableEnded = false;
  let writableFinished = false;
  let responseDestroyed = false;
  let responseClosed = false;
  let writableNeedDrain = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let resolveResponse!: (response: Response | undefined) => void;
  let rejectResponse!: (error: unknown) => void;
  let resolved = false;
  const encoder = new TextEncoder();

  const emitResponseClose = () => {
    if (responseClosed) return;
    responseClosed = true;
    responseEvents.emit("close");
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    cancel() {
      responseDestroyed = true;
      closeRequest();
      emitResponseClose();
    },
    pull() {
      if (!writableNeedDrain) return;
      writableNeedDrain = false;
      responseEvents.emit("drain");
    },
  });

  const resolveOnce = (response: Response | undefined) => {
    if (resolved) return;
    resolved = true;
    resolveResponse(response);
  };
  const statusAllowsBody = () => status !== 101 && status !== 204 && status !== 205 && status !== 304;
  const ensureResponse = () => {
    if (headersSent) return;
    headersSent = true;
    resolveOnce(new Response(statusAllowsBody() ? body : null, { status, headers: responseHeaders }));
  };
  const writeChunk = (chunk: Buffer | string | Uint8Array) => {
    ensureResponse();
    if (!statusAllowsBody() || !controllerRef || writableEnded) return true;
    // Native capture reuses its callback buffer after write() returns. Web
    // streams retain enqueued arrays, so every non-string chunk needs owned
    // storage before the producer is allowed to continue.
    const data = typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk);
    try {
      controllerRef.enqueue(data);
    } catch {
      return false;
    }
    writableNeedDrain = (controllerRef.desiredSize ?? 0) <= 0;
    return !writableNeedDrain;
  };

  const fakeRes = {
    get headersSent() { return headersSent; },
    get writableEnded() { return writableEnded; },
    get writableFinished() { return writableFinished; },
    get destroyed() { return responseDestroyed; },
    get writableNeedDrain() { return writableNeedDrain; },
    get statusCode() { return status; },
    set statusCode(nextStatus: number) { status = nextStatus; },
    writeHead(nextStatus: number, headers?: Record<string, string | number | string[]>) {
      status = nextStatus;
      if (headers) {
        responseHeaders = new Headers();
        for (const [key, value] of Object.entries(headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else {
            responseHeaders.set(key, String(value));
          }
        }
      }
      ensureResponse();
    },
    write(
      chunk: Buffer | string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ) {
      const accepted = writeChunk(chunk);
      const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      done?.();
      return accepted;
    },
    end(chunk?: Buffer | string | Uint8Array) {
      if (chunk !== undefined) writeChunk(chunk);
      ensureResponse();
      writableEnded = true;
      writableFinished = true;
      try {
        controllerRef?.close();
      } catch {
        // The consumer may already have cancelled the stream.
      }
      responseEvents.emit("finish");
      emitResponseClose();
      closeRequest();
    },
    destroy(error?: Error) {
      if (responseDestroyed) return fakeRes;
      ensureResponse();
      responseDestroyed = true;
      writableEnded = true;
      try {
        controllerRef?.error(error ?? new Error("Response destroyed"));
      } catch {
        // The consumer may already have cancelled the stream.
      }
      if (error && responseEvents.listenerCount("error") > 0) responseEvents.emit("error", error);
      emitResponseClose();
      closeRequest();
      return fakeRes;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      responseEvents.on(event, listener);
      return fakeRes;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      responseEvents.once(event, listener);
      return fakeRes;
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      responseEvents.off(event, listener);
      return fakeRes;
    },
  } as unknown as ServerResponse;

  const responsePromise = new Promise<Response | undefined>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  let handling: Promise<void>;
  try {
    handling = Promise.resolve(handler(fakeReq, fakeRes, () => resolveOnce(undefined)));
  } catch (error) {
    handling = Promise.reject(error);
  }
  if (requestWasAlreadyAborted) handleRequestAbort();
  void handling
    .then(() => {
      if (!resolved && writableEnded) {
        resolveOnce(new Response(null, { status, headers: responseHeaders }));
      }
    }, (error) => {
      if (resolved) fakeRes.destroy(error instanceof Error ? error : undefined);
      else rejectResponse(error);
    });

  void (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      reader = request.body?.getReader() ?? null;
      requestBodyReader = reader;
      if (reader) {
        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          requestEvents.emit("data", Buffer.from(value));
        }
      }
      if (!abortController.signal.aborted) requestEvents.emit("end");
    } catch {
      closeRequest(true);
    } finally {
      if (requestBodyReader === reader) requestBodyReader = null;
      if (reader) {
        if (abortController.signal.aborted) await reader.cancel().catch(() => {});
        try { reader.releaseLock(); } catch {}
      }
    }
  })();

  return responsePromise;
}
