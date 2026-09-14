// @ts-ignore vendored module, absent until `bun run build:vendor`
import {
  cameraLaunchArgs,
  createRouter,
  fromWsSocket,
  seedCameraFeeds,
  type WsWebSocketLike,
} from '../../vendor/serve-emu/dist/middleware.js';

import { type EmulatorCameraFeeds } from './device-actions';
import { AndroidSession } from './android-session';
import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuWebSocketOptions,
} from './serve-emu-options';

export const EMU_PREFIX = '/vendor/serve-emu';

const serveEmuOptions = readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]);
const router = createRouter(serveEmuOptions);

export const emuCameraFeeds: EmulatorCameraFeeds = {
  launchArgs: cameraLaunchArgs,
  seedPlaceholders: seedCameraFeeds,
};

const androidSession = new AndroidSession(router);

export const startAndroidScreenRecording = (directory: string): Promise<void> =>
  androidSession.startRecording(directory);

export const finishAndroidScreenRecording = (): Promise<void> => androidSession.finishRecording();

export const shutdownAndroid = (): Promise<void> => androidSession.shutdown();

// Preserve embedded-host cleanup. The CLI awaits the same shutdown promise before exiting.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdownAndroid().catch(() => {});
  });
}
process.once('exit', () => {
  void router.stopAll();
});

export function handleEmuRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rest = `${url.pathname.slice(EMU_PREFIX.length) || '/'}${url.search}`;
  const forwarded = new Request(`${url.origin}${rest}`, request);
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
