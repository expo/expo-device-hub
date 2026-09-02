// @ts-ignore vendored module, absent until `bun run build:vendor`
import { createRouter, fromWsSocket, type WsWebSocketLike } from '../../vendor/serve-emu/dist/middleware.js';

import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuWebSocketOptions,
} from './serve-emu-options';
import { handleServeEmuDeviceOptionRequest } from './serve-emu-device-options';

export const EMU_PREFIX = '/vendor/serve-emu';

const DEVICE_OPTION_COMPAT_PATHNAMES = new Set([
  '/api/network',
  '/api/font-scale',
  '/api/reduce-motion',
  '/api/high-text-contrast',
  '/api/font-weight',
]);

const router = createRouter(readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]));

function stopAll(): void {
  try {
    router.stopAll();
  } catch {}
}
process.once('exit', stopAll);
process.once('SIGINT', stopAll);
process.once('SIGTERM', stopAll);

export function handleEmuRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rest = `${url.pathname.slice(EMU_PREFIX.length) || '/'}${url.search}`;
  const forwarded = new Request(`${url.origin}${rest}`, request);
  const pathname = new URL(forwarded.url).pathname;
  if (DEVICE_OPTION_COMPAT_PATHNAMES.has(pathname)) {
    return router
      .ensure(url.searchParams.get('device'))
      .then(async ({ serial }) =>
        (await handleServeEmuDeviceOptionRequest(forwarded, serial)) ??
        new Response('not found', { status: 404 }),
      )
      .catch((error) =>
        Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 503 },
        ),
      );
  }
  return router.handleRequest(forwarded);
}

async function attachEmuSocket(socket: WsWebSocketLike, request: Request): Promise<void> {
  const url = new URL(request.url);
  let serial: string;
  try {
    serial = (await router.ensure(url.searchParams.get('device'))).serial;
  } catch {
    try {
      socket.close();
    } catch {}
    return;
  }
  const { video, frameMeta } = serveEmuWebSocketOptions(url);
  router.attachWebSocket(fromWsSocket(socket), { serial, video, frameMeta });
}

export const emuWebSocketHandler = (socket: WsWebSocketLike, request: Request): void => {
  void attachEmuSocket(socket, request);
};
