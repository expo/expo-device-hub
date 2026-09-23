import { type IncomingMessage, type ServerResponse } from "http";
import { once } from "events";
import { Readable } from "stream";
import { type UpgradeHandlerWebSocket } from "./middleware-utils";

type RequestInitWithDuplex = RequestInit & { duplex?: "half" };

/** Fetch-style middleware signature, matching what `simMiddleware` returns. */
export type WebMiddleware = ((request: Request) => Response | undefined | Promise<Response | undefined>) & {
  /** WebSocket hook (exec channel); returns true when handled. */
  handleWebSocket?: (request: Request, websocket: UpgradeHandlerWebSocket) => boolean;
};

/** Bodies are small (JSON control routes); uploads ride the WebSocket channel, not HTTP. */
const MAX_BUFFERED_REQUEST_BYTES = 8 * 1024 * 1024;

/**
 * Bun's `node:http` drops the response status when a reply is written with the request still unread,
 * which is what an auth failure does: every refused POST reached the client as an empty 200.
 */
export class RequestBodyTooLargeError extends Error {}

export async function readRequestBodyAsync(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BUFFERED_REQUEST_BYTES) {
      // Keep draining but stop buffering: destroying the request would take the socket with it,
      // and returning early would hand the middleware a partial body as if it were whole.
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new RequestBodyTooLargeError();
  return Buffer.concat(chunks);
}

export function nodeRequestToWeb(
  req: IncomingMessage,
  res?: ServerResponse,
  body?: Buffer,
): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const host = headers.get("host") ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const controller = new AbortController();
  res?.on("close", () => controller.abort());

  const init: RequestInitWithDuplex = {
    method: req.method,
    headers,
    signal: controller.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (body) {
      init.body = new Uint8Array(body);
    } else {
      init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
  }
  return new Request(url, init);
}

export async function writeWebResponse(
  originalReq: IncomingMessage,
  res: ServerResponse,
  response: Response | undefined,
): Promise<void> {
  if (!response) {
    if (!res.headersSent) res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (originalReq.method === "HEAD" || !response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let closed = false;
  const onClose = () => {
    closed = true;
    void reader.cancel().catch(() => {});
  };
  res.once("close", onClose);
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await Promise.race([once(res, "drain"), once(res, "close")]);
        if (closed || res.destroyed) break;
      }
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
}
