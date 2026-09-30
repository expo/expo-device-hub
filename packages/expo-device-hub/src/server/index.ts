/**
 * Expo Hub DevTools plugin server entry point. Expo CLI calls the default export for
 * `/_expo/plugins/expo-device-hub/*` (prefix stripped) and mounts each `webSocketHandlers`
 * route at `/_expo/plugins/expo-device-hub/<route>`. Bundled to `dist/server/index.mjs`.
 *
 * Any host can mount this the same way under a different prefix (strip the prefix, then
 * call the handler) by setting EXPO_DEVICE_HUB_BASE_PATH to that prefix ('' = origin
 * root) before importing — serve-sim bakes the mount into the URLs it hands the browser,
 * so it must be known server-side (see ./serve-sim.ts).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { SERVER_HIDE_BOOT_DEVICE } from './boot-device';
import {
  bootHubDevice,
  createHubDevice,
  parseCreateDeviceAction,
  parseDeviceAction,
  removeHubDevice,
  shutdownHubDevice,
} from './device-actions';
import { configureClientShell } from './client-shell';
import { argentInteractionWebSocketHandler } from './argent-interaction-websocket';
import { deviceListWebSocketHandler, refreshDeviceList } from './device-list-websocket';
import { type HubDeviceList, listDevices } from './devices';
import { ANDROID_RECORDING_STOP_ROUTE, handleEasEndpoint, READY_ROUTE } from './eas-endpoints';
import { MOUNT_PATH } from './mount';
import { SERVER_PLATFORM_FILTER } from './platform-filter';
import {
  EMU_PREFIX,
  EMU_TOKEN_SUBPROTOCOL_PREFIX,
  emuCameraFeeds,
  emuWebSocketHandler,
  handleEmuRequest,
  finishAndroidScreenRecording,
} from './serve-emu';
import { SIM_PREFIX, SIM_TOKEN_SUBPROTOCOL_PREFIX, handleSimRequest, simWebSocketHandler } from './serve-sim';
import {
  authorizeRequest,
  authorizeUpgrade,
  frameAncestorsPolicy,
  withBearerToken,
} from './session-auth';
import { FRAME_ANCESTORS, SESSION_TOKEN } from './session-token';
import { SERVER_SHARE_URL } from './share-url';
import { SERVER_HIDE_SIDEBAR } from './sidebar';
import { listNewDeviceOptions } from './sim-options';
import { SERVER_TRANSPORT } from './transport';
export { startAndroidScreenRecording, shutdownAndroid } from './serve-emu';

const DEVICES_ROUTE = '/api/devices';
const SHUTDOWN_DEVICE_ROUTE = '/api/devices/shutdown';
const REMOVE_DEVICE_ROUTE = '/api/devices/remove';
const BOOT_DEVICE_ROUTE = '/api/devices/boot';
const CREATE_DEVICE_ROUTE = '/api/devices/create';
const NEW_DEVICE_OPTIONS_ROUTE = '/api/new-device-options';
const DEVICES_WEBSOCKET_ROUTE = '/api/devices/ws';
const ARGENT_INTERACTIONS_WEBSOCKET_ROUTE = '/api/argent-interactions/ws';

// Under a session token every route needs it, so a new route is gated by default. A liveness
// probe cannot carry a token, and EAS stops a recording with its own token instead.
const UNGATED_ROUTES = new Set([READY_ROUTE, ANDROID_RECORDING_STOP_ROUTE]);
// serve-sim never takes the token from a capture URL, and takes recording control only with a
// bearer. The Hub keeps both rules, so its own cookie and query token do not widen them.
const SIM_CAPTURE_PREFIX = `${SIM_PREFIX}/network-capture`;
const SIM_HELPER_PREFIX = `${SIM_PREFIX}/helper/`;
const TOKEN_SUBPROTOCOL_PREFIXES = [SIM_TOKEN_SUBPROTOCOL_PREFIX, EMU_TOKEN_SUBPROTOCOL_PREFIX];
const FRAME_POLICY_HEADERS: Record<string, string> = SESSION_TOKEN
  ? { 'Content-Security-Policy': frameAncestorsPolicy(FRAME_ANCESTORS) }
  : {};
/** For the files the standalone CLI serves itself once `handler` passed a request on. */
export const staticFileHeaders: Readonly<Record<string, string>> = FRAME_POLICY_HEADERS;

// The exported dashboard shell (dist/client/index.html, a sibling of the
// dist/server bundle this file becomes). Its asset URLs are relative and its
// `<base href="{{mount}}/">` carries a placeholder, so it must be served
// through this handler — which substitutes the actual mount — rather than as a
// plain static file. Read lazily and cached: the file is absent until
// `build:web` has run (e.g. dev serve via modules/expo-device-hub), in which
// case we fall through to the host's own static serving / 404.
let clientIndexHtml: string | null = null;
async function serveClientIndexHtml(): Promise<Response | null> {
  if (clientIndexHtml === null) {
    try {
      clientIndexHtml = await readFile(
        fileURLToPath(new URL('../client/index.html', import.meta.url)),
        'utf-8'
      );
    } catch {
      return null;
    }
  }
  return new Response(
    configureClientShell(clientIndexHtml, {
      mountPath: MOUNT_PATH,
      platform: SERVER_PLATFORM_FILTER,
      transport: SERVER_TRANSPORT,
      hideSidebar: SERVER_HIDE_SIDEBAR,
      hideBootDevice: SERVER_HIDE_BOOT_DEVICE,
      sessionToken: SESSION_TOKEN,
      shareUrl: SERVER_SHARE_URL,
    }),
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...FRAME_POLICY_HEADERS,
      },
    }
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function isSimPath(pathname: string): boolean {
  return pathname === SIM_PREFIX || pathname.startsWith(`${SIM_PREFIX}/`);
}

function isEmuPath(pathname: string): boolean {
  return pathname === EMU_PREFIX || pathname.startsWith(`${EMU_PREFIX}/`);
}

// serve-sim drops empty segments and reads the first one as the device, so
// `/helper/<udid>//recording/video/` is recording control too.
function isSimRecordingControl(pathname: string): boolean {
  if (!pathname.startsWith(SIM_HELPER_PREFIX)) return false;
  const segments = pathname.slice(SIM_HELPER_PREFIX.length).split('/').filter(Boolean);
  return segments.length === 3 && segments[1] === 'recording' && segments[2] === 'video';
}

/**
 * The response that refuses a request, or the request to route. An authorized request carries
 * the token as a bearer, because the vendored backends' own gates never see the Hub's cookie.
 * Recording control keeps the credential it came with.
 */
function gateRequest(request: Request, pathname: string): Request | Response {
  if (!SESSION_TOKEN || UNGATED_ROUTES.has(pathname)) return request;
  // A preflight cannot carry the token. Each backend answers or refuses one in its own gate, and
  // routes none: serve-sim answers every preflight, serve-emu only its WebRTC ones.
  if (request.method === 'OPTIONS' && (isSimPath(pathname) || isEmuPath(pathname))) return request;
  const refused = authorizeRequest(request, SESSION_TOKEN, {
    mountPath: MOUNT_PATH,
    htmlHeaders: FRAME_POLICY_HEADERS,
    allowQueryToken: !pathname.startsWith(SIM_CAPTURE_PREFIX),
  });
  if (refused) return refused;
  return isSimRecordingControl(pathname) ? request : withBearerToken(request, SESSION_TOKEN);
}

/**
 * Every response the gate let through names who may frame it, not only the dashboard: a backend
 * page, such as serve-emu's own UI, takes input too. A response that already names its frame
 * policy, such as serve-sim's pages, keeps its own.
 */
function withFramePolicy(response: Response | null): Response | null {
  const policy = FRAME_POLICY_HEADERS['Content-Security-Policy'];
  if (!response || !policy) return response;
  if (response.headers.get('content-security-policy')?.includes('frame-ancestors')) return response;
  // A copy, because a backend's response headers may be immutable, as a redirect's are.
  const framed = new Response(response.body, response);
  framed.headers.append('Content-Security-Policy', policy);
  return framed;
}

export default async function handler(request: Request): Promise<Response | null> {
  const gated = gateRequest(request, new URL(request.url).pathname);
  if (gated instanceof Response) return gated;
  return withFramePolicy(await routeRequest(gated));
}

async function routeRequest(request: Request): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);

  const easResponse = await handleEasEndpoint(request, {
    mountPath: MOUNT_PATH,
    serveSimPrefix: SIM_PREFIX,
    recordingControlToken: process.env.EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN,
    finishAndroidRecording: finishAndroidScreenRecording,
  });
  if (easResponse) return easResponse;

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveClientIndexHtml();
  }

  if (isSimPath(pathname)) {
    return handleSimRequest(request);
  }
  if (isEmuPath(pathname)) {
    return handleEmuRequest(request);
  }

  if (pathname === DEVICES_ROUTE) {
    const devices = await listDevices(SERVER_PLATFORM_FILTER);
    const bootedOnly = searchParams.get('booted') === 'true' || searchParams.get('booted') === '1';
    return jsonResponse(bootedOnly ? filterBooted(devices) : devices);
  }

  if (pathname === SHUTDOWN_DEVICE_ROUTE || pathname === REMOVE_DEVICE_ROUTE) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const action = await parseDeviceAction(request);
    if (!action) {
      return jsonResponse({ ok: false, error: 'Expected { platform, id, name } JSON body' }, 400);
    }

    try {
      const result =
        pathname === SHUTDOWN_DEVICE_ROUTE
          ? await shutdownHubDevice(action)
          : await removeHubDevice(action);
      if (result.ok) refreshDeviceList();
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (pathname === BOOT_DEVICE_ROUTE) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const action = await parseDeviceAction(request);
    if (!action) {
      return jsonResponse({ ok: false, error: 'Expected { platform, id, name } JSON body' }, 400);
    }

    try {
      const result = await bootHubDevice(action, emuCameraFeeds);
      if (result.ok) refreshDeviceList();
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (pathname === CREATE_DEVICE_ROUTE) {
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }

    const action = await parseCreateDeviceAction(request);
    if (!action) {
      return jsonResponse(
        { ok: false, error: 'Expected { platform, name, runtime, deviceType } JSON body' },
        400
      );
    }

    try {
      const result = await createHubDevice(action, emuCameraFeeds);
      if (result.ok) refreshDeviceList();
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 500);
    }
  }

  if (pathname === NEW_DEVICE_OPTIONS_ROUTE) {
    if (request.method !== 'GET') {
      return jsonResponse({ ok: false, error: 'Method Not Allowed' }, 405);
    }
    return jsonResponse(await listNewDeviceOptions(SERVER_PLATFORM_FILTER));
  }

  return null;
}

type GatedSocket = {
  close(code?: number, reason?: string): void;
  on(event: 'error', listener: () => void): unknown;
};

/** Upgrades skip the request gate, so each socket route checks the token before its handler. */
function gatedSocket<Socket extends GatedSocket>(
  handle: (socket: Socket, request: Request) => void
): (socket: Socket, request: Request) => void {
  const token = SESSION_TOKEN;
  if (!token) return handle;
  return (socket, request) => {
    // `ws` emits `error` when a peer breaks the protocol, even while the socket closes, and an
    // error with no listener throws. Without this, a client without the token could stop the Hub.
    socket.on('error', () => socket.close());
    if (!authorizeUpgrade(request, token, TOKEN_SUBPROTOCOL_PREFIXES)) {
      socket.close(1008, 'Unauthorized');
      return;
    }
    handle(socket, withBearerToken(request, token));
  };
}

export const webSocketHandlers = {
  [DEVICES_WEBSOCKET_ROUTE]: gatedSocket(deviceListWebSocketHandler),
  [ARGENT_INTERACTIONS_WEBSOCKET_ROUTE]: gatedSocket(argentInteractionWebSocketHandler),
  [`${SIM_PREFIX}/exec-ws`]: gatedSocket(simWebSocketHandler),
  [`${SIM_PREFIX}/helper/ws`]: gatedSocket(simWebSocketHandler),
  [`${EMU_PREFIX}/ws`]: gatedSocket(emuWebSocketHandler),
};

function filterBooted(list: HubDeviceList): HubDeviceList {
  return {
    simulators: list.simulators.filter((device) => device.booted),
    emulators: list.emulators.filter((device) => device.booted),
    errors: list.errors,
  };
}
