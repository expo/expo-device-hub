import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

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
let simOptions: Record<string, unknown> = {};
let emuOptions: Record<string, unknown> = {};
let deviceListings = 0;

mock.module('../../../vendor/serve-sim/dist/middleware.js', () => ({
  simMiddleware: (options: Record<string, unknown>) => {
    simOptions = options;
    return Object.assign(
      async (request: Request) => {
        simRequests.push(request);
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
  createRouter: (options: Record<string, unknown>) => {
    emuOptions = options;
    return {
      handleRequest: async (request: Request) => {
        emuRequests.push(request);
        return new Response('emu');
      },
      authorizeUpgrade: (request: Request) => {
        emuUpgrades.push(request);
        return true;
      },
      ensure: async () => ({ serial: 'emulator-5554' }),
      attachWebSocket: () => {},
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
    expect(simOptions).toMatchObject({ execToken: TOKEN, requirePreviewToken: true });
    expect(emuOptions).toMatchObject({ sessionToken: TOKEN });
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

  // serve-sim answers a preflight before its own gate and never routes it.
  test('passes a serve-sim preflight through without a credential', async () => {
    const response = await request('/vendor/serve-sim/api', { method: 'OPTIONS' });

    expect(response?.status).toBe(200);
    expect(simRequests.map((r) => r.headers.get('authorization'))).toEqual([null]);
    expect((await request('/api/devices', { method: 'OPTIONS' }))?.status).toBe(401);
  });

  test('closes every socket that carries no token, before it reaches a backend', () => {
    for (const route of Object.keys(server.webSocketHandlers)) {
      expect([route, openSocket(route).closed]).toEqual([route, { code: 1008, reason: 'Unauthorized' }]);
    }
    expect(simSockets).toEqual([]);
    expect(emuUpgrades).toEqual([]);
  });

  test('forwards an authorized socket to each backend with the token as a bearer', async () => {
    const same = { cookie, origin: ORIGIN, host: '192.168.1.20:3400' };

    expect(openSocket('/vendor/serve-sim/exec-ws', same).closed).toBeNull();
    expect(openSocket('/vendor/serve-emu/ws', { 'sec-websocket-protocol': `serve-emu.token.${TOKEN}` }).closed).toBeNull();
    await Promise.resolve();

    expect(simSockets.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
    expect(emuUpgrades.map((r) => r.headers.get('authorization'))).toEqual([`Bearer ${TOKEN}`]);
  });
});
