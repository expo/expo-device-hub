import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** `http(s)://host` origin of an incoming request, for absolutizing its URL. */
export function requestOrigin(request: IncomingMessage): string {
  const proto = 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http';
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

export function toFetchRequest(request: IncomingMessage): Request {
  const method = request.method ?? 'GET';
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : (Readable.toWeb(request) as unknown as BodyInit);
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
