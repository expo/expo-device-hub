// @ts-ignore vendored module, absent until `bun run build:vendor`
import { createRouter, fromWsSocket, type WsWebSocketLike } from '../../vendor/serve-emu/dist/middleware.js';

export const EMU_PREFIX = '/vendor/serve-emu';

const router = createRouter();

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
  return router.handleRequest(new Request(`${url.origin}${rest}`, request));
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
  const frameMeta = url.searchParams.get('frame-meta') === '1';
  router.attachWebSocket(fromWsSocket(socket), { serial, frameMeta });
}

export const emuWebSocketHandler = (socket: WsWebSocketLike, request: Request): void => {
  void attachEmuSocket(socket, request);
};
