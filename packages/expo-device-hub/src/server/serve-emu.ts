// @ts-ignore vendored module, absent until `bun run build:vendor`
import { createRouter, fromWsSocket, type WsWebSocketLike } from '../../vendor/serve-emu/dist/middleware.js';

import {
  readStandaloneServeEmuOptions,
  SERVE_EMU_OPTIONS_ENV,
  serveEmuWebSocketOptions,
} from './serve-emu-options';
import { handleServeEmuDeviceOptionRequest } from './serve-emu-device-options';
import {
  DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS,
  handleServeEmuStreamStatsRequest,
  SERVE_EMU_STREAM_STATS_PATH,
} from './serve-emu-stream-stats';

export const EMU_PREFIX = '/vendor/serve-emu';

const serveEmuOptions = readStandaloneServeEmuOptions(process.env[SERVE_EMU_OPTIONS_ENV]);
const router = createRouter(serveEmuOptions);
type ActiveEmuApp = {
  handleRequest: (request: Request) => Promise<Response>;
  health: () => { codec?: string; frames: number; sourceFps: number };
  isStreaming: () => boolean;
};
const activeApps = new Map<string, ActiveEmuApp>();

async function ensureEmu(requested: string | null): Promise<{ serial: string; app: ActiveEmuApp }> {
  const resolved = await router.ensure(requested);
  activeApps.set(resolved.serial, resolved.app);
  return resolved;
}

function stopAll(): void {
  activeApps.clear();
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
  if (pathname === SERVE_EMU_STREAM_STATS_PATH) {
    return handleServeEmuStreamStatsRequest(forwarded, async () => {
      const serial = router.resolveSerial(url.searchParams.get('device'));
      const app = activeApps.get(serial);
      if (!app?.isStreaming()) throw new Error('No active serve-emu stream');
      return {
        ...app.health(),
        targetBitrateBps:
          serveEmuOptions.bitRate ?? DEFAULT_SERVE_EMU_TARGET_BITRATE_BPS,
        webRtcEnabled: serveEmuOptions.streamSettings.transport === 'webrtc',
      };
    });
  }
  if (pathname === '/webrtc/offer' || pathname === '/webrtc/close') {
    return ensureEmu(url.searchParams.get('device'))
      .then(({ app }) => app.handleRequest(forwarded))
      .catch((error) =>
        Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 503 },
        ),
      );
  }
  if (pathname === '/api/network' || pathname === '/api/font-scale') {
    return ensureEmu(url.searchParams.get('device'))
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
    serial = (await ensureEmu(url.searchParams.get('device'))).serial;
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
