import { describe, expect, test } from 'bun:test';

import {
  accessCookieName,
  authorizeRequest,
  authorizeUpgrade,
  frameAncestorsPolicy,
} from '../session-auth';

const TOKEN = 'hub-session-token';
const ORIGIN = 'http://192.168.1.20:3400';
const FRAME_POLICY = { 'Content-Security-Policy': "frame-ancestors 'self'" };

/** What a browser sends when it opens a link from another site. */
const NAVIGATION = {
  accept: 'text/html',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'cross-site',
};

const cookie = `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}`;

function gate(path: string, init?: RequestInit, mountPath = '') {
  return authorizeRequest(new Request(`${ORIGIN}${path}`, init), TOKEN, {
    mountPath,
    htmlHeaders: FRAME_POLICY,
  });
}

describe('authorizeRequest', () => {
  test('refuses an API call without the token with a JSON 401', async () => {
    const response = gate('/api/devices', { headers: { accept: 'application/json' } });

    expect(response?.status).toBe(401);
    expect(response?.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response?.headers.get('content-security-policy')).toBeNull();
    expect(await response?.json()).toMatchObject({ ok: false });
  });

  test('serves the token form, with the frame policy, to a page load without the token', async () => {
    const response = gate('/', { headers: NAVIGATION });

    expect(response?.status).toBe(401);
    expect(response?.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response?.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    const body = await response!.text();
    expect(body).toContain('only opens with a token');
    expect(body).not.toContain('isn&#39;t valid');
    expect(body).not.toContain("isn't valid");
    expect(body).not.toContain(TOKEN);
  });

  test('says so on the form when the link carried a wrong token', async () => {
    const body = await gate('/?token=not-it', { headers: NAVIGATION })!.text();

    expect(body).toContain("This token isn't valid.");
    expect(body).not.toContain('not-it');
  });

  test('trades a link token for a cookie and redirects it out of the URL', () => {
    const response = gate(`/?device=ABC&token=${TOKEN}`, { headers: NAVIGATION });

    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe('/?device=ABC');
    expect(response?.headers.get('cache-control')).toBe('no-store, private');
    expect(response?.headers.get('set-cookie')).toBe(
      `${accessCookieName(TOKEN)}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Lax; Path=/`,
    );
  });

  test('scopes the cookie and the redirect to the mount path', () => {
    const response = gate(`/?token=${TOKEN}`, { headers: NAVIGATION }, '/_expo/plugins/expo-device-hub');

    expect(response?.headers.get('location')).toBe('/_expo/plugins/expo-device-hub/');
    expect(response?.headers.get('set-cookie')).toEndWith('; Path=/_expo/plugins/expo-device-hub');
  });

  // A leading "//" would be read as an absolute URL on another origin.
  test('never redirects to another origin', () => {
    const response = gate(`//evil.example/?token=${TOKEN}`, { headers: NAVIGATION });

    expect(response?.headers.get('location')).toBe('/evil.example/');
  });

  test('marks the cookie Secure behind an https tunnel', () => {
    const response = gate(`/?token=${TOKEN}`, {
      headers: { ...NAVIGATION, 'x-forwarded-proto': 'https' },
    });

    expect(response?.headers.get('set-cookie')).toContain('; Secure');
    expect(response?.headers.get('set-cookie')).toContain('SameSite=Lax');
  });

  // A cross-site frame never receives a Lax cookie.
  test('partitions the cookie for a framed page over https', () => {
    const response = gate(`/?token=${TOKEN}`, {
      headers: { ...NAVIGATION, 'sec-fetch-dest': 'iframe', 'x-forwarded-proto': 'https' },
    });

    expect(response?.headers.get('set-cookie')).toContain('SameSite=None; Path=/; Secure; Partitioned');
  });

  test('serves a caller that cannot set a header, such as EventSource, with the query token', () => {
    expect(gate(`/api/devices?token=${TOKEN}`, { headers: { accept: 'text/event-stream' } })).toBeNull();
  });

  test('accepts a bearer header', () => {
    expect(gate('/api/devices', { headers: { Authorization: `Bearer ${TOKEN}` } })).toBeNull();
  });

  test('ignores a query token where the caller turns it off', () => {
    const options = { mountPath: '', allowQueryToken: false };
    const refuse = (init: RequestInit) =>
      authorizeRequest(new Request(`${ORIGIN}/network-capture?token=${TOKEN}`, init), TOKEN, options);

    expect(refuse({ headers: { accept: 'application/json' } })?.status).toBe(401);
    expect(refuse({ headers: NAVIGATION })?.status).toBe(401);
    expect(refuse({ headers: { Authorization: `Bearer ${TOKEN}` } })).toBeNull();
  });

  test('accepts the cookie on a same-origin request and on the page load after the redirect', () => {
    expect(gate('/api/devices', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).toBeNull();
    expect(gate('/api/devices', { headers: { cookie, origin: ORIGIN, host: '192.168.1.20:3400' } })).toBeNull();
    expect(gate('/', { headers: { ...NAVIGATION, cookie } })).toBeNull();
  });

  // Another page on the same site sends the cookie too, and could read this response.
  test('refuses the cookie on a subresource request from another origin', () => {
    const response = gate('/api/devices', {
      headers: { cookie, 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-site' },
    });

    expect(response?.status).toBe(401);
  });

  test('refuses a cookie or a bearer that carries the wrong token', () => {
    const wrongCookie = `${accessCookieName(TOKEN)}=not-the-token`;

    expect(gate('/', { headers: { ...NAVIGATION, cookie: wrongCookie } })?.status).toBe(401);
    expect(gate('/api/devices', { headers: { Authorization: 'Bearer not-the-token' } })?.status).toBe(401);
  });

  // Cookies ignore the port, so two Hubs on one host must not share one name.
  test('names the cookie after the token', () => {
    expect(accessCookieName(TOKEN)).toMatch(/^expo_device_hub_access_[0-9a-f]{8}$/);
    expect(accessCookieName('another-token')).not.toBe(accessCookieName(TOKEN));
  });
});

describe('authorizeUpgrade', () => {
  const upgrade = (headers: Record<string, string>, query = '') =>
    authorizeUpgrade(new Request(`${ORIGIN}/api/devices/ws${query}`, { headers }), TOKEN);

  test('accepts a bearer header', () => {
    expect(upgrade({ Authorization: `Bearer ${TOKEN}` })).toBe(true);
  });

  // Browsers name the token as a subprotocol for the backend they reach through the Hub.
  test('accepts the serve-sim and serve-emu token subprotocols', () => {
    expect(upgrade({ 'sec-websocket-protocol': `serve-sim.token.${TOKEN}` })).toBe(true);
    expect(upgrade({ 'sec-websocket-protocol': `binary, serve-emu.token.${TOKEN}` })).toBe(true);
    expect(upgrade({ 'sec-websocket-protocol': 'serve-emu.token.not-it' })).toBe(false);
    expect(upgrade({ 'sec-websocket-protocol': `other.token.${TOKEN}` })).toBe(false);
  });

  test('accepts the cookie only from the same origin', () => {
    expect(upgrade({ cookie, origin: ORIGIN, host: '192.168.1.20:3400' })).toBe(true);
    expect(upgrade({ cookie, origin: 'http://evil.example', host: '192.168.1.20:3400' })).toBe(false);
  });

  // Proxy and tunnel access logs record query strings.
  test('refuses the query token and a bare upgrade', () => {
    expect(upgrade({}, `?token=${TOKEN}`)).toBe(false);
    expect(upgrade({})).toBe(false);
  });
});

describe('frameAncestorsPolicy', () => {
  test("allows only the Hub itself by default", () => {
    expect(frameAncestorsPolicy([])).toBe("frame-ancestors 'self'");
  });

  test('adds each named origin, including a subdomain wildcard', () => {
    expect(frameAncestorsPolicy(['https://expo.dev/', 'https://*.expo.dev', 'http://localhost:3000'])).toBe(
      "frame-ancestors 'self' https://expo.dev https://*.expo.dev http://localhost:3000",
    );
  });

  test('drops shapes that would widen the policy beyond what they name', () => {
    expect(frameAncestorsPolicy(['*', 'https://*', 'https://*.com', 'not a url', "https://a.dev 'unsafe-inline'"])).toBe(
      "frame-ancestors 'self'",
    );
  });
});
