import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { accessCookieName } from '../session-auth';

const TOKEN = 'hub-gate-token';
const ORIGIN = 'http://192.168.1.20:3400';
const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;
const SAME_ORIGIN = { cookie, 'sec-fetch-site': 'same-origin' };

// What reached each vendored backend, and with which credential.
const simRequests: Request[] = [];
const simSockets: Request[] = [];
const emuRequests: Request[] = [];
const emuUpgrades: Request[] = [];
const emuAttached: Array<{ request?: Request }> = [];
let simOptions: Record<string, unknown> = {};
let emuOptions: Record<string, unknown> = {};
let deviceListings = 0;

mock.module('../../../vendor/serve-sim/dist/middleware.js', () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    return Object.assign(
      async (request: Request) => {
        simRequests.push(request);
        // serve-sim names its own frame policy on its pages.
        if (new URL(request.url).pathname.endsWith('/framed')) {
          return new Response('sim', { headers: { 'Content-Security-Policy': "frame-ancestors 'self' https://a.dev" } });
        }
        return new Response('sim');
      },
      {
        handleWebSocket: (request: Request) => {
          simSockets.push(request);
          return true;
        },
      },
    );
  },
}));

mock.module('../../../vendor/serve-emu/dist/middleware.js', () => ({
  cameraLaunchArgs: () => [],
  seedCameraFeeds: async () => {},
  fromWsSocket: (socket: unknown) => socket,
  SESSION_TOKEN_SUBPROTOCOL_PREFIX: 'serve-emu.token.',
  createRouter: (options: Record<string, unknown>) => {
    emuOptions = options;
    return {
      handleRequest: async (request: Request) => {
        emuRequests.push(request);
        // A redirect's headers are immutable.
        if (new URL(request.url).pathname === '/moved') return Response.redirect('http://emu.test/', 302);
        return new Response('emu');
      },
      authorizeUpgrade: (request: Request) => {
        emuUpgrades.push(request);
        return true;
      },
      ensure: async () => ({ serial: 'emulator-5554' }),
      attachWebSocket: (_socket: unknown, options: { request?: Request }) => {
        emuAttached.push(options);
      },
      startScreenRecording: async () => {},
      finishScreenRecording: async () => null,
      stopAll: async () => {},
    };
  },
}));

mock.module('../devices', () => ({
  listDevices: async () => {
    deviceListings++;
    return { simulators: [], emulators: [], errors: [] };
  },
  listAndroidEmulators: async () => [],
}));

// The standalone CLI sets these before it imports the server bundle.
const previousEnv = { ...process.env };
process.env.EXPO_DEVICE_HUB_BASE_PATH = '';
process.env.EXPO_DEVICE_HUB_SESSION_TOKEN = TOKEN;
process.env.EXPO_DEVICE_HUB_FRAME_ANCESTORS = JSON.stringify(['https://*.expo.dev']);
process.env.EXPO_DEVICE_HUB_RECORDING_CONTROL_TOKEN = 'recording-token';
const server = await import('../index');

afterAll(() => {
  process.env = previousEnv;
});

beforeEach(() => {
  simRequests.length = 0;
  simSockets.length = 0;
  emuRequests.length = 0;
  emuUpgrades.length = 0;
  emuAttached.length = 0;
  deviceListings = 0;
});

const request = (path: string, init?: RequestInit) =>
  server.default(new Request(`${ORIGIN}${path}`, init));

function fakeSocket() {
  const socket = {
    closed: null as null | { code?: number; reason?: string },
    bufferedAmount: 0,
    send: () => {},
    on: () => {},
    close(code?: number, reason?: string) {
      socket.closed = { code, reason };
    },
  };
  return socket;
}

function openSocket(route: string, headers: Record<string, string> = {}) {
  const socket = fakeSocket();
  const handler = server.webSocketHandlers[route as keyof typeof server.webSocketHandlers] as (
    socket: unknown,
    request: Request,
  ) => void;
  handler(socket, new Request(`${ORIGIN}${route}`, { headers }));
  return socket;
}

describe('the Hub under a session token', () => {
  test('hands the token to the vendored serve-sim and serve-emu gates', () => {
    expect(simOptions).toMatchObject({
      execToken: TOKEN,
      requirePreviewToken: true,
      frameAncestors: ['https://*.expo.dev'],
    });
    expect(emuOptions).toMatchObject({ sessionToken: TOKEN });
  });

  test('lets only the Hub and each --frame-ancestor frame its pages', async () => {
    const response = await request('/', { headers: { 'sec-fetch-dest': 'document' } });

    expect(response?.status).toBe(401);
    expect(response?.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://*.expo.dev"
    );
  });

  test('refuses its own routes and both backends without the token', async () => {
    const paths = ['/', '/index.html', '/api/devices', '/api/new-device-options', '/metrics', '/vendor/serve-sim/api', '/vendor/serve-emu/api/devices'];

    for (const path of paths) expect([path, (await request(path))?.status]).toEqual([path, 401]);
    expect((await request('/api/devices/boot', { method: 'POST', body: '{}' }))?.status).toBe(401);
    expect(deviceListings).toBe(0);
    expect(simRequests).toEqual([]);
    expect(emuRequests).toEqual([]);
  });

  // A route the Hub does not know still falls through to static files, so it is gated too.
  test('refuses a path it does not route, which the CLI would serve as a static file', async () => {
    expect((await request('/_expo/static/js/web/index.js'))?.status).toBe(401);
  });

  test('keeps the liveness probe open', async () => {
    expect((await request('/readyz'))?.status).toBe(200);
  });

  // EAS stops the recording with its own token, which is not the session token.
  test('leaves the recording stop to its own token', async () => {
    const response = await request('/_eas/android-recording/stop', {
      method: 'POST',
      headers: { Authorization: 'Bearer recording-token' },
    });

    expect(response?.status).not.toBe(401);
  });

  test('answers its own routes for the cookie it handed out', async () => {
    expect((await request('/api/devices', { headers: SAME_ORIGIN }))?.status).toBe(200);
    expect(deviceListings).toBe(1);
  });

  // The backends never see the Hub's cookie name, so the Hub passes the token on as a bearer.
  test('forwards an authorized request to each backend with the token as a bearer', async () => {
    await request('/vendor/serve-sim/api', { headers: SAME_ORIGIN });
    await request('/vendor/serve-emu/api/devices', { headers: SAME_ORIGIN });

    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
    expect(emuRequests.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
  });

  // serve-emu's own UI is a page that takes input, so no gated response may be framed by any site.
  test('sends the frame policy on every response it routes, not only on the dashboard', async () => {
    for (const path of ['/vendor/serve-emu/', '/vendor/serve-emu/moved', '/vendor/serve-sim/api', '/readyz']) {
      const response = await request(path, { headers: SAME_ORIGIN });
      expect([path, response?.headers.get('content-security-policy')]).toEqual([path, "frame-ancestors 'self'"]);
    }
    // The CLI sets these on the static files it serves after `handler` passed a request on.
    expect(server.staticFileHeaders).toEqual({ 'Content-Security-Policy': "frame-ancestors 'self'" });
  });

  test("keeps a backend's own frame policy", async () => {
    const response = await request('/vendor/serve-sim/framed', { headers: SAME_ORIGIN });

    expect(response?.headers.get('content-security-policy')).toBe("frame-ancestors 'self' https://a.dev");
  });

  // A preflight cannot carry the token. Each backend answers or refuses one before its own gate.
  test('passes a backend preflight through without a credential, and refuses one for the Hub', async () => {
    expect((await request('/vendor/serve-sim/api', { method: 'OPTIONS' }))?.status).toBe(200);
    expect((await request('/vendor/serve-emu/webrtc/stats', { method: 'OPTIONS' }))?.status).toBe(200);

    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([null]);
    expect(emuRequests.map((r) => r.headers.get('authorization'))).toEqual([null]);
    expect((await request('/api/devices', { method: 'OPTIONS' }))?.status).toBe(401);
  });

  // serve-sim takes recording control only with a bearer, never with its cookie.
  test('forwards recording control with the credential it came with, never one it adds', async () => {
    const path = '/vendor/serve-sim/helper/UDID-1/recording/video';

    await request(path, { method: 'POST', headers: SAME_ORIGIN, body: '{}' });
    await request(path, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });

    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([null, `Bearer ${TOKEN}`]);
  });

  // serve-sim drops empty path segments, so these paths reach recording control too.
  test('adds no bearer to recording control spelled with extra slashes', async () => {
    for (const path of [
      '/vendor/serve-sim/helper/UDID-1//recording/video',
      '/vendor/serve-sim/helper//UDID-1/recording//video/',
    ]) {
      await request(path, { method: 'POST', headers: SAME_ORIGIN, body: '{}' });
    }

    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([null, null]);
  });

  // serve-sim never takes the token from a capture URL, which logs and referrers can record.
  test('refuses a query token on the capture routes', async () => {
    expect((await request(`/vendor/serve-sim/network-capture?device=UDID-1&token=${TOKEN}`))?.status).toBe(401);
    expect(
      (await request('/vendor/serve-sim/network-capture?device=UDID-1', { headers: SAME_ORIGIN }))?.status
    ).toBe(200);
  });

  test('closes every socket that carries no token, before it reaches a backend', () => {
    for (const route of Object.keys(server.webSocketHandlers)) {
      expect([route, openSocket(route).closed]).toEqual([route, { code: 1008, reason: 'Unauthorized' }]);
    }
    expect(simSockets).toEqual([]);
    expect(emuUpgrades).toEqual([]);
  });

  // `ws` emits `error` when a peer breaks the protocol, even while the socket closes, and an error
  // with no listener throws. Without one, any client could stop the Hub, token or not.
  test('handles a socket error on a refused socket and on an accepted serve-emu socket', () => {
    const refused = Object.assign(new EventEmitter(), { close() {} });
    const accepted = Object.assign(new EventEmitter(), { close() {}, bufferedAmount: 0, send() {} });
    const handlers = server.webSocketHandlers as Record<string, (socket: unknown, request: Request) => void>;

    handlers['/api/devices/ws'](refused, new Request(`${ORIGIN}/api/devices/ws`));
    handlers['/vendor/serve-emu/ws'](
      accepted,
      new Request(`${ORIGIN}/vendor/serve-emu/ws`, {
        headers: { 'sec-websocket-protocol': `serve-emu.token.${TOKEN}` },
      })
    );

    expect(() => refused.emit('error', new Error('WS_ERR_EXPECTED_MASK'))).not.toThrow();
    expect(() => accepted.emit('error', new Error('WS_ERR_EXPECTED_MASK'))).not.toThrow();
  });

  test('forwards an authorized socket to each backend with the token as a bearer', async () => {
    const same = { cookie, origin: ORIGIN, host: '192.168.1.20:3400' };

    expect(openSocket('/vendor/serve-sim/exec-ws', same).closed).toBeNull();
    expect(openSocket('/vendor/serve-emu/ws', { 'sec-websocket-protocol': `serve-emu.token.${TOKEN}` }).closed).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(simSockets.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
    expect(emuUpgrades.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
    // serve-emu's `attachWebSocket` checks the token again and closes a socket that has none.
    expect(emuAttached.map((o) => o.request?.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
  });
});
