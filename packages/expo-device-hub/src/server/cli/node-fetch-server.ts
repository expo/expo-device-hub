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

/** Keep body cancellation separate from the socket that must still deliver the response. */
function requestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  let stopped = false;
  let stopReading = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onData = (chunk: Buffer) => {
        if (stopped) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) request.pause();
      };
      const cleanup = () => {
        request.off('data', onData);
        request.off('end', onEnd);
        request.off('error', onError);
        request.off('close', onClose);
      };
      const onEnd = () => {
        if (!stopped) {
          stopped = true;
          controller.close();
        }
        cleanup();
      };
      const onError = (error: Error) => {
        if (!stopped) {
          stopped = true;
          controller.error(error);
        }
        cleanup();
      };
      const onClose = () => onError(new Error('Request closed before its body completed'));
      stopReading = () => { request.off('data', onData); };
      request.pause();
      request.on('data', onData);
      request.once('end', onEnd);
      request.once('error', onError);
      request.once('close', onClose);
      if (request.readableEnded) onEnd();
      else if (request.destroyed) onClose();
    },
    pull() {
      if (!stopped) request.resume();
    },
    cancel() {
      // Readable.toWeb destroys the IncomingMessage on cancellation. After Request forwarding,
      // Node can still deliver data to its closed controller (ERR_INVALID_STATE). Detach first,
      // then discard the unread upload so an early rejection can finish and keep-alive can work.
      stopped = true;
      stopReading();
      request.resume();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: request.readableHighWaterMark }));
}

export function toFetchRequest(request: IncomingMessage): Request {
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : requestBody(request);
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
