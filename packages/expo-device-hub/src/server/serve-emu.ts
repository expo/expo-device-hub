// @ts-ignore vendored module, absent until `bun run build:vendor`
import { cameraLaunchArgs, createRouter, fromWsSocket, seedCameraFeeds, type WsWebSocketLike } from '../../vendor/serve-emu/dist/middleware.js';

import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuWebSocketOptions,
} from './serve-emu-options';

export const EMU_PREFIX = '/vendor/serve-emu';

const serveEmuOptions = readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]);
const router = createRouter(serveEmuOptions);

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
  return router.handleRequest(forwarded);
}

/**
 * The `emulator` camera flags for a serial, with its feed files already seeded.
 * The emulator opens the PNGs at startup, so both must precede the spawn.
 */
export async function prepareEmuCameraFeeds(serial: string): Promise<string[]> {
  await seedCameraFeeds(serial);
  return cameraLaunchArgs(serial);
}

export function setEmuCameraWired(serial: string, wired: boolean): void {
  router.setCameraWired(serial, wired);
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
