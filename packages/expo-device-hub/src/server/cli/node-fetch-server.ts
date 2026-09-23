import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** `http(s)://host` origin of an incoming request, for absolutizing its URL. */
export function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const clientProto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)
    ?.split(',', 1)[0]
    ?.trim()
    .toLowerCase();
  const socketProto = 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
  const proto = clientProto === 'http' || clientProto === 'https' ? clientProto : socketProto;
  return `${proto}://${request.headers.host ?? 'localhost'}`;
}

function convertHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  const { rawHeaders } = request;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name != null && value != null) headers.append(name, value);
  }
  return headers;
}

/**
 * The request body as a web stream. Hand-rolled instead of `Readable.toWeb`:
 * a handler may answer before it reads the body (the serve-sim token gate
 * answers 401 to a POST at once), after which the consumer cancels the stream
 * while the socket is still delivering the body. Node's adapter then throws
 * "Controller is already closed" from the `data` listener and takes the whole
 * process down. Here a cancelled stream just drains the rest of the body.
 */
export function incomingBodyStream(request: Readable): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      request.on('data', (chunk: Buffer | string) => {
        if (finished) return;
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        if ((controller.desiredSize ?? 0) <= 0) request.pause();
      });
      request.once('end', () => {
        if (finished) return;
        finished = true;
        controller.close();
      });
      request.once('error', (error) => {
        if (finished) return;
        finished = true;
        controller.error(error);
      });
      request.pause();
    },
    pull() {
      request.resume();
    },
    cancel() {
      // Nobody wants the rest; keep the connection usable by draining it.
      finished = true;
      request.resume();
    },
  });
}

export function toFetchRequest(request: IncomingMessage): Request {
  const method = request.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD'
      ? undefined
      : (incomingBodyStream(request) as unknown as BodyInit);
  return new Request(new URL(request.url ?? '/', requestOrigin(request)).href, {
    method,
    headers: convertHeaders(request),
    body,
    // Stream bodies require explicit half-duplex (absent from lib.dom's RequestInit).
    ...(body ? { duplex: 'half' } : null),
  } as RequestInit);
}

/** The upgrade Request shape the Expo CLI hands plugin `webSocketHandlers`. */
export function toUpgradeRequest(request: IncomingMessage, route: string): Request {
  const url = new URL(request.url ?? '/', requestOrigin(request));
  url.pathname = route;
  return new Request(url.href, { method: request.method ?? 'GET', headers: convertHeaders(request) });
}

export function writeFetchResponse(response: Response, res: ServerResponse): void {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  // Piped rather than buffered: preview video streams (MJPEG) never end.
  const body = Readable.fromWeb(response.body as unknown as NodeReadableStream);
  body.pipe(res);
  body.once('error', () => res.destroy());
  res.once('close', () => body.destroy());
}
