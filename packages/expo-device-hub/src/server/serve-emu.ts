// @ts-ignore vendored module, absent until `bun run build:vendor`
import {
  cameraLaunchArgs,
  createRouter,
  fromWsSocket,
  seedCameraFeeds,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX,
  type WsWebSocketLike,
} from '../../vendor/serve-emu/dist/middleware.js';

import { type EmulatorCameraFeeds } from './device-actions';
import { AndroidSession, type RecordingFinish, type RecordingStart } from './android-session';
import { recordingLimitsFromEnv } from './recording-limits';
import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuAllowsOrigin,
  serveEmuWebSocketOptions,
} from './serve-emu-options';
import { SESSION_TOKEN } from './session-token';

export const EMU_PREFIX = '/vendor/serve-emu';
/** The subprotocol prefix a browser names serve-emu's session token under. */
export const EMU_TOKEN_SUBPROTOCOL_PREFIX: string = SESSION_TOKEN_SUBPROTOCOL_PREFIX;

/** The `ws` socket the transport hands over; `on('error')` lets the Hub guard it. */
type EmuSocket = WsWebSocketLike & { on(event: 'error', listener: () => void): unknown };

const serveEmuOptions = readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]);
const router = createRouter({
  ...serveEmuOptions,
  // The Hub's gate runs first and passes an authorized request on with the token as a bearer.
  ...(SESSION_TOKEN ? { sessionToken: SESSION_TOKEN } : {}),
});

/** Whether serve-emu lets a page on `origin` read its response to `request`. */
export const emuAllowsOrigin = (origin: URL, request: Request): boolean =>
  serveEmuAllowsOrigin(serveEmuOptions.allowedOrigins ?? [], origin, request);

export const emuCameraFeeds: EmulatorCameraFeeds = {
  launchArgs: cameraLaunchArgs,
  seedPlaceholders: seedCameraFeeds,
};

const androidSession = new AndroidSession(router);

export const startAndroidScreenRecording = async (directory: string): Promise<RecordingStart> =>
  await androidSession.startRecording(directory, recordingLimitsFromEnv(process.env));

export const finishAndroidScreenRecording = (): Promise<RecordingFinish> =>
  androidSession.finishRecording();

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

async function attachEmuSocket(socket: EmuSocket, request: Request): Promise<void> {
  // Before `ensure`, which starts the device.
  if (!router.authorizeUpgrade(request)) {
    socket.close(1008, 'Unauthorized');
    return;
  }
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
  // The router checks the token again here and closes the socket without it.
  router.attachWebSocket(fromWsSocket(socket), { serial, video, frameMeta, request });
}

export const emuWebSocketHandler = (socket: EmuSocket, request: Request): void => {
  void attachEmuSocket(socket, request);
};
