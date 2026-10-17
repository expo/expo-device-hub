import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { accessCookieName } from '../session-auth';

// The real device servers answer each preflight. Loaded through a variable, so the Hub's type check
// does not compile their sources, which use another `tsconfig`.
const EMU_SOURCE = '../../../../serve-emu/packages/serve-emu/src/middleware.ts';
const SIM_SOURCE = '../../../../serve-sim/packages/serve-sim/src/middleware.ts';
const { createRouter: realEmuRouter } = (await import(EMU_SOURCE)) as {
  createRouter: (options: { allowedOrigins?: string[] }) => { handleRequest(request: Request): Promise<Response> };
};
const { simMiddleware: realSimMiddleware } = (await import(SIM_SOURCE)) as {
  simMiddleware: (options: { basePath: string; corsOrigins?: string[] }) => (
    request: Request,
  ) => Promise<Response | undefined>;
};

const TOKEN = 'hub-gate-token';
const ORIGIN = 'http://192.168.1.20:3400';
const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;
const SAME_ORIGIN = { cookie, 'sec-fetch-site': 'same-origin' };
// The policy for the `--frame-ancestor` origin the CLI hands over below.
const FRAME_POLICY = "frame-ancestors 'self' https://*.expo.dev";
// The `--cors-origin` page the CLI hands over below.
const PAGE = 'https://page.example';

// What reached each vendored backend, and with which credential.
const simRequests: Request[] = [];
const simSockets: Request[] = [];
const emuRequests: Request[] = [];
const emuUpgrades: Request[] = [];
const emuAttached: Array<{ request?: Request }> = [];
let simOptions: Record<string, unknown> = {};
let emuOptions: Record<string, unknown> = {};
let deviceListings = 0;
// Makes the Hub's own device list throw, as a failing `simctl` or `adb` would.
let deviceListingFails = false;

mock.module('../../../vendor/serve-sim/dist/middleware.js', () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    // The real middleware answers each preflight, so a test sees what a browser gets before it sends
    // the request itself.
    const preflight = realSimMiddleware({
      basePath: options.basePath as string,
      corsOrigins: options.corsOrigins as string[],
    });
    return Object.assign(
      async (request: Request) => {
        simRequests.push(request);
        if (request.method === 'OPTIONS') return preflight(request);
        if (new URL(request.url).pathname.endsWith('/throws')) throw new Error('sim failed');
        // serve-sim passes a path it does not route on to its host.
        if (new URL(request.url).pathname.endsWith('/unrouted')) return undefined;
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
    // The real router answers each preflight, before its token gate and without a device.
    const preflight = realEmuRouter({ allowedOrigins: options.allowedOrigins as string[] });
    return {
      handleRequest: async (request: Request) => {
        emuRequests.push(request);
        if (request.method === 'OPTIONS') return preflight.handleRequest(request);
        if (new URL(request.url).pathname === '/throws') throw new Error('emu failed');
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
    if (deviceListingFails) throw new Error('/private/var/devices.json: EACCES');
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
process.env.EXPO_DEVICE_HUB_SERVE_SIM_OPTIONS = JSON.stringify({ corsOrigins: [PAGE] });
process.env.EXPO_DEVICE_HUB_SERVE_EMU_OPTIONS = JSON.stringify({ allowedOrigins: [PAGE] });
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
  deviceListingFails = false;
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
    expect(response?.headers.get('content-security-policy')).toBe(FRAME_POLICY);
  });

  test('refuses its own routes and both backends without the token', async () => {
    const paths = ['/', '/index.html', '/api/devices', '/api/new-device-options', '/metrics', '/vendor/serve-sim/api', '/vendor/serve-emu/api/devices'];

    for (const path of paths) expect([path, (await request(path))?.status]).toEqual([path, 401]);
    expect((await request('/api/devices/boot', { method: 'POST', body: '{}' }))?.status).toBe(401);
    expect(deviceListings).toBe(0);
    expect(simRequests).toEqual([]);
    expect(emuRequests).toEqual([]);
  });

  // Otherwise the page sees only a network error, as if the Hub were down.
  test('lets a --cors-origin page read why either backend refused it', async () => {
    for (const path of ['/vendor/serve-sim/api', '/vendor/serve-emu/api/devices']) {
      const response = await request(path, { headers: { Origin: PAGE } });
      expect([path, response?.status]).toEqual([path, 401]);
      expect(response?.headers.get('access-control-allow-origin')).toBe(PAGE);
      expect(response?.headers.get('vary')).toBe('Origin');
    }
  });

  // Another site's page can send a form-like POST without a preflight, so the token alone does not
  // stop it. Each device action checks the page's origin before it runs, with or without a token.
  test('refuses a device action from a page it does not allow', async () => {
    const post = (path: string, origin?: string, extra: Record<string, string> = {}) =>
      request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Bearer ${TOKEN}`,
          ...(origin ? { Origin: origin } : {}),
          ...extra,
        },
        // An unknown platform makes a Hub action answer 400 before it touches a device, so this test
        // can never shut down a real simulator, even if the check it tests breaks.
        body: '{"platform":"none","id":"all"}',
      });

    const actions = ['/api/devices/shutdown', '/api/devices/remove', '/api/devices/boot', '/api/devices/create'];
    for (const path of actions) {
      for (const origin of ['https://elsewhere.example', 'http://localhost:5173']) {
        const refused = await post(path, origin);
        expect([path, origin, refused?.status]).toEqual([path, origin, 403]);
      }
    }

    // A --cors-origin page, the Hub's own page, the browser's same-origin mark, and a CLI reach the
    // route, which refuses the unknown platform.
    const allowed: Array<[string | undefined, Record<string, string>]> = [
      [PAGE, {}],
      [ORIGIN, {}],
      ['https://192.168.1.20:3400', { 'Sec-Fetch-Site': 'same-origin' }],
      [undefined, {}],
    ];
    for (const [origin, extra] of allowed) {
      expect([origin, (await post('/api/devices/shutdown', origin, extra))?.status]).toEqual([origin, 400]);
    }
  });

  // serve-sim and serve-emu refuse such a page on their own routes, so the Hub passes its origin on.
  test("passes a page's origin on to the backend that checks it", async () => {
    for (const path of ['/vendor/serve-sim/grid/api/shutdown', '/vendor/serve-emu/api/network']) {
      await request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TOKEN}`, Origin: 'https://elsewhere.example' },
        body: '{}',
      });
    }
    expect(simRequests.at(-1)?.headers.get('origin')).toBe('https://elsewhere.example');
    expect(emuRequests.at(-1)?.headers.get('origin')).toBe('https://elsewhere.example');
  });

  // A host that embeds the Hub may have its own routes behind it, which answer for themselves.
  test('leaves a state change on a path the Hub does not own to its host', async () => {
    const response = await request('/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TOKEN}`, Origin: 'https://elsewhere.example' },
      body: '{}',
    });
    expect(response).toBeNull();
  });

  // A browser sends the preflight first, then the request with the token it has.
  test('lets a --cors-origin page read every kind of token refusal after its preflight', async () => {
    // Each backend's real preflight lets the page send the token header at all.
    for (const path of ['/vendor/serve-emu/api/devices', '/vendor/serve-sim/api']) {
      const preflight = await request(path, {
        method: 'OPTIONS',
        headers: {
          Origin: PAGE,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect([path, preflight?.status]).toEqual([path, 204]);
      expect([path, preflight?.headers.get('access-control-allow-origin')]).toEqual([path, PAGE]);
      expect(preflight?.headers.get('access-control-allow-headers')).toContain('Authorization');
    }
    simRequests.length = 0;
    emuRequests.length = 0;

    const wrong = { Origin: PAGE, Authorization: 'Bearer wrong-token' };
    const refusals: Array<[string, RequestInit]> = [
      ['/vendor/serve-emu/api/devices', { headers: wrong }],
      ['/vendor/serve-sim/api', { headers: wrong }],
      ['/vendor/serve-emu/api/devices?token=wrong-token', { headers: { Origin: PAGE } }],
      ['/vendor/serve-sim/stream.mjpeg?token=wrong-token', { headers: { Origin: PAGE } }],
      ['/vendor/serve-emu/api/screenshot', { method: 'POST', headers: wrong }],
      ['/vendor/serve-emu/api/devices', { headers: { ...wrong, 'sec-fetch-dest': 'document' } }],
    ];
    for (const [path, init] of refusals) {
      const response = await request(path, init);
      const body = (await response?.text()) ?? '';
      expect([path, response?.status]).toEqual([path, 401]);
      expect([path, response?.headers.get('access-control-allow-origin')]).toEqual([path, PAGE]);
      expect([path, body.includes('wrong-token') || body.includes(TOKEN)]).toEqual([path, false]);
    }
    expect(simRequests).toEqual([]);
    expect(emuRequests).toEqual([]);
  });

  // The backends answer their own route errors; this covers one that escapes them.
  test('answers a backend failure with a 500 that a --cors-origin page can read', async () => {
    const authorized = { Origin: PAGE, Authorization: `Bearer ${TOKEN}` };
    for (const path of ['/vendor/serve-sim/throws', '/vendor/serve-emu/throws']) {
      const allowed = await request(path, { headers: authorized });
      const other = await request(path, {
        headers: { Origin: 'https://elsewhere.example', Authorization: `Bearer ${TOKEN}` },
      });
      expect([path, allowed?.status]).toEqual([path, 500]);
      expect([path, allowed?.headers.get('access-control-allow-origin')]).toEqual([path, PAGE]);
      expect(await allowed?.json()).toEqual({ ok: false, error: 'Internal Server Error' });
      expect([path, allowed?.headers.get('content-security-policy')]).toEqual([path, FRAME_POLICY]);
      expect([path, other?.headers.get('access-control-allow-origin')]).toEqual([path, null]);
    }
  });

  test("answers a Hub route that throws with a 500 that a --cors-origin page can read", async () => {
    deviceListingFails = true;
    const authorized = { Authorization: `Bearer ${TOKEN}` };

    const allowed = await request('/api/devices', { headers: { ...authorized, Origin: PAGE } });
    const other = await request('/api/devices', { headers: { ...authorized, Origin: 'https://elsewhere.example' } });

    expect(allowed?.status).toBe(500);
    expect(allowed?.headers.get('access-control-allow-origin')).toBe(PAGE);
    expect(await allowed?.json()).toEqual({ ok: false, error: 'Internal Server Error' });
    expect(other?.status).toBe(500);
    expect(other?.headers.get('access-control-allow-origin')).toBeNull();
    expect(other?.headers.get('vary')).toBe('Origin');
  });

  // Otherwise the host (the CLI or Expo) would answer a 404 without CORS headers, which a page that
  // passed the preflight could not read.
  test('answers an unknown Hub or backend path with a 404 a --cors-origin page can read', async () => {
    const authorized = { Authorization: `Bearer ${TOKEN}`, Origin: PAGE };
    const preflight = await request('/api/unknown', { method: 'OPTIONS', headers: { Origin: PAGE } });
    expect(preflight?.status).toBe(204);

    for (const path of ['/api/unknown', '/vendor/serve-sim/unrouted']) {
      const missing = await request(path, { headers: authorized });
      expect([path, missing?.status]).toEqual([path, 404]);
      expect([path, missing?.headers.get('access-control-allow-origin')]).toEqual([path, PAGE]);
      expect(await missing?.json()).toEqual({ ok: false, error: 'Not Found' });
    }
  });

  test('leaves a static file path to its host', async () => {
    expect(await request('/_expo/static/js/web/index.js', { headers: SAME_ORIGIN })).toBeNull();
  });

  test('names no other origin on a refusal, and a --cors-origin page on its own routes too', async () => {
    const other = await request('/vendor/serve-emu/api/devices', { headers: { Origin: 'https://elsewhere.example' } });
    const own = await request('/api/devices', { headers: { Origin: PAGE } });

    expect(other?.status).toBe(401);
    expect(other?.headers.get('access-control-allow-origin')).toBeNull();
    expect(other?.headers.get('vary')).toBe('Origin');
    expect(own?.status).toBe(401);
    expect(own?.headers.get('access-control-allow-origin')).toBe(PAGE);
  });

  // The expo.dev preview probes `/healthz`, and a page may list devices, from its own origin.
  test("lets a --cors-origin page read the Hub's own routes, and no other page", async () => {
    for (const path of ['/healthz', '/readyz']) {
      const allowed = await request(path, { headers: { Origin: PAGE } });
      const other = await request(path, { headers: { Origin: 'https://elsewhere.example' } });
      expect([path, allowed?.status, allowed?.headers.get('access-control-allow-origin')]).toEqual([path, 200, PAGE]);
      expect([path, other?.headers.get('access-control-allow-origin'), other?.headers.get('vary')]).toEqual([
        path,
        null,
        'Origin',
      ]);
    }
    const devices = await request('/api/devices', { headers: { Origin: PAGE, Authorization: `Bearer ${TOKEN}` } });
    expect(devices?.status).toBe(200);
    expect(devices?.headers.get('access-control-allow-origin')).toBe(PAGE);
  });

  // serve-sim allows any loopback page; serve-emu only one that calls a Hub on a loopback host.
  test("follows each backend's loopback rule on a refusal", async () => {
    const headers = { Origin: 'http://localhost:5173' };
    const allowOrigin = async (url: string) =>
      (await server.default(new Request(url, { headers })))?.headers.get('access-control-allow-origin');

    expect(await allowOrigin(`${ORIGIN}/vendor/serve-sim/api`)).toBe('http://localhost:5173');
    expect(await allowOrigin(`${ORIGIN}/vendor/serve-emu/api/devices`)).toBeNull();
    expect(await allowOrigin('http://127.0.0.1:3400/vendor/serve-emu/api/devices')).toBe('http://localhost:5173');
  });

  // serve-emu counts `*.localhost` as loopback; serve-sim does not.
  test('names a *.localhost page on a serve-emu refusal only', async () => {
    const allowOrigin = async (url: string) =>
      (await server.default(new Request(url, { headers: { Origin: 'http://preview.localhost:5173' } })))
        ?.headers.get('access-control-allow-origin');

    expect(await allowOrigin('http://127.0.0.1:3400/vendor/serve-emu/api/devices')).toBe(
      'http://preview.localhost:5173',
    );
    expect(await allowOrigin('http://127.0.0.1:3400/vendor/serve-sim/api')).toBeNull();
  });

  // A route the Hub does not know still falls through to static files, so it is gated too.
  test('refuses a path it does not route, which the CLI would serve as a static file', async () => {
    expect((await request('/_expo/static/js/web/index.js'))?.status).toBe(401);
  });

  // The expo.dev preview page probes `/healthz` without a token, as it does serve-sim's.
  test('keeps the health and readiness probes open', async () => {
    expect((await request('/healthz'))?.status).toBe(200);
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
      expect([path, response?.headers.get('content-security-policy')]).toEqual([path, FRAME_POLICY]);
    }
    // The CLI sets these on the static files it serves after `handler` passed a request on.
    expect(server.staticFileHeaders).toEqual({ 'Content-Security-Policy': FRAME_POLICY });
  });

  test("keeps a backend's own frame policy", async () => {
    const response = await request('/vendor/serve-sim/framed', { headers: SAME_ORIGIN });

    expect(response?.headers.get('content-security-policy')).toBe("frame-ancestors 'self' https://a.dev");
  });

  // A preflight cannot carry the token. Each backend answers or refuses one before its own gate.
  test('passes a backend preflight through without a credential, and answers one for the Hub itself', async () => {
    expect((await request('/vendor/serve-sim/api', { method: 'OPTIONS' }))?.status).toBe(204);
    expect((await request('/vendor/serve-emu/webrtc/stats', { method: 'OPTIONS' }))?.status).toBe(204);

    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([null]);
    expect(emuRequests.map((r) => r.headers.get('authorization'))).toEqual([null]);

    const hub = await request('/api/devices', {
      method: 'OPTIONS',
      headers: { Origin: PAGE, 'Access-Control-Request-Headers': 'authorization' },
    });
    expect(hub?.status).toBe(204);
    expect(hub?.headers.get('access-control-allow-origin')).toBe(PAGE);
    expect(hub?.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(deviceListings).toBe(0);
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

  // The origin check runs before the token check, so a page that is not allowed cannot use a token
  // it holds, and a Hub without a token refuses it the same way.
  test('closes a socket from a page it does not allow, even with the token', () => {
    const credentials = {
      cookie,
      'sec-websocket-protocol': `serve-emu.token.${TOKEN}`,
      origin: 'https://elsewhere.example',
    };
    for (const route of Object.keys(server.webSocketHandlers)) {
      expect([route, openSocket(route, credentials).closed]).toEqual([
        route,
        { code: 1008, reason: 'Origin not allowed' },
      ]);
    }
    // Another scheme on the Hub's own host is not its page.
    const host = new URL(ORIGIN).host;
    for (const origin of [`ws://${host}`, `file://${host}`]) {
      expect([origin, openSocket('/vendor/serve-emu/ws', { ...credentials, origin }).closed]).toEqual([
        origin,
        { code: 1008, reason: 'Origin not allowed' },
      ]);
    }
    expect(simSockets).toEqual([]);
    expect(emuUpgrades).toEqual([]);
    expect(emuAttached).toEqual([]);
  });

  // A Hub without --require-token has no token check, so the origin check is all that stands
  // between another site's page and device input.
  test('checks the origin on every socket of a Hub without a token too', () => {
    const ungated = server.webSocketHandlersFor(undefined) as Record<
      string,
      (socket: unknown, request: Request) => void
    >;
    const open = (route: string, origin?: string) => {
      const socket = fakeSocket();
      ungated[route]!(socket, new Request(`${ORIGIN}${route}`, { headers: origin ? { origin } : {} }));
      return socket.closed;
    };

    for (const route of Object.keys(ungated)) {
      expect([route, open(route, 'https://elsewhere.example')]).toEqual([
        route,
        { code: 1008, reason: 'Origin not allowed' },
      ]);
    }
    expect(simSockets).toEqual([]);
    expect(emuAttached).toEqual([]);
    for (const origin of [ORIGIN, PAGE, undefined]) {
      expect([origin, open('/vendor/serve-emu/ws', origin)]).toEqual([origin, null]);
    }
  });

  // A page on another name that resolves here (DNS rebinding) carries that name in Host. Without a
  // token, the Hub answers only localhost and IP addresses; with one, the token stops such a page.
  test('closes a socket for another host name on a Hub without a token, and leaves it to the token', async () => {
    const ungated = server.webSocketHandlersFor(undefined) as Record<
      string,
      (socket: unknown, request: Request) => void
    >;
    for (const route of Object.keys(ungated)) {
      const socket = fakeSocket();
      ungated[route]!(socket, new Request(`http://rebound.example:3400${route}`));
      expect([route, socket.closed]).toEqual([route, { code: 1008, reason: 'Host not allowed' }]);
    }
    const local = fakeSocket();
    ungated['/vendor/serve-emu/ws']!(local, new Request('http://localhost:3400/vendor/serve-emu/ws'));
    expect(local.closed).toBeNull();

    const gated = await server.default(
      new Request('http://rebound.example:3400/api/devices', { headers: { Authorization: `Bearer ${TOKEN}` } }),
    );
    expect(gated?.status).toBe(200);
  });

  test("opens a socket from the Hub's own page, a --cors-origin page, or a client without Origin", () => {
    const token = { 'sec-websocket-protocol': `serve-emu.token.${TOKEN}` };
    for (const origin of [ORIGIN, PAGE, undefined]) {
      const headers = origin ? { ...token, origin } : token;
      expect([origin, openSocket('/vendor/serve-emu/ws', headers).closed]).toEqual([origin, null]);
      expect([origin, openSocket('/api/devices/ws', { ...headers, cookie }).closed]).toEqual([origin, null]);
    }
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
