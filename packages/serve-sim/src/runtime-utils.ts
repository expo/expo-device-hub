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

export function nodeRequestToWeb(req: IncomingMessage, res?: ServerResponse): Request {
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
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
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
