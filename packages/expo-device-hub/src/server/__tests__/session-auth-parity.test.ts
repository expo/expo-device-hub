import { describe, expect, test } from 'bun:test';

// serve-sim's own gate, from source: the vendored build is absent in CI, and this module reads
// nothing at import.
import {
  accessCookieName as serveSimCookieName,
  assertPreviewAccess,
  assertUpgradeAccess,
} from '../../../../serve-sim/packages/serve-sim/src/session-auth';
import { accessCookieName, authorizeRequest, authorizeUpgrade } from '../session-auth';

/**
 * `session-auth.ts` ports serve-sim's `--require-token` gate. Each case below runs through both
 * gates, so a change to either one that makes them disagree fails here.
 */

const TOKEN = 'parity-session-token';
const HOST = '192.168.1.20:3400';
const ORIGIN = `http://${HOST}`;

const PAGE = { accept: 'text/html', 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const FRAME = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' };
const FETCH = { 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors' };

type Case = {
  name: string;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  /** Present the gate's own cookie, or one that does not decode. */
  cookie?: 'valid' | 'malformed';
  allowQueryToken?: boolean;
};

const REQUEST_CASES: Case[] = [
  { name: 'an API call with no credential', headers: { ...FETCH, 'sec-fetch-site': 'same-origin' } },
  { name: 'a page load with no credential', headers: { ...PAGE, 'sec-fetch-site': 'none' } },
  { name: 'a page load with the query token', path: `/?device=UDID-1&token=${TOKEN}`, headers: PAGE },
  {
    name: 'a framed page load with the query token behind https',
    path: `/?token=${TOKEN}`,
    headers: { ...FRAME, 'sec-fetch-site': 'cross-site', 'x-forwarded-proto': 'https' },
  },
  { name: 'an EventSource with the query token', path: `/logs?token=${TOKEN}`, headers: FETCH },
  { name: 'a page load with a wrong query token', path: '/?token=nope', headers: PAGE },
  { name: 'a page load with an empty query token', path: '/?token=', headers: PAGE },
  { name: 'a bearer', headers: { ...FETCH, authorization: `Bearer ${TOKEN}` } },
  { name: 'a lower-case bearer with extra space', headers: { ...FETCH, authorization: `bearer   ${TOKEN}` } },
  { name: 'a wrong bearer', headers: { ...FETCH, authorization: 'Bearer nope' } },
  { name: 'the cookie from the same origin', cookie: 'valid', headers: { ...FETCH, 'sec-fetch-site': 'same-origin' } },
  { name: 'the cookie from the same site', cookie: 'valid', headers: { ...FETCH, 'sec-fetch-site': 'same-site' } },
  { name: 'the cookie on a link from another site', cookie: 'valid', headers: { ...PAGE, 'sec-fetch-site': 'cross-site' } },
  { name: 'the cookie in a frame on another site', cookie: 'valid', headers: { ...FRAME, 'sec-fetch-site': 'cross-site' } },
  { name: 'the cookie on a form post from another site', method: 'POST', cookie: 'valid', headers: { ...PAGE, 'sec-fetch-site': 'cross-site' } },
  { name: 'the cookie with no fetch metadata and the same Origin', method: 'POST', cookie: 'valid', headers: { origin: ORIGIN } },
  { name: 'the cookie with no fetch metadata and another Origin', method: 'POST', cookie: 'valid', headers: { origin: 'http://evil.example' } },
  { name: 'a cookie that does not decode', cookie: 'malformed', headers: { ...FETCH, 'sec-fetch-site': 'same-origin' } },
  { name: 'the query token where the route refuses one', path: `/network-capture?token=${TOKEN}`, headers: FETCH, allowQueryToken: false },
];

function cookieHeader(name: string, kind: Case['cookie']): Record<string, string> {
  if (!kind) return {};
  return { cookie: `${name}=${kind === 'valid' ? encodeURIComponent(TOKEN) : '%E0%A4%A'}` };
}

/** The part of an answer both gates must agree on. Body text and cookie names differ on purpose. */
function outcome(status: number | null, headers: Record<string, string | null>, body = '') {
  if (status === null) return { status: 'passed' };
  return {
    status,
    page: (headers['content-type'] ?? '').startsWith('text/html'),
    rejectedToken: body.includes('aria-describedby="token-error"'),
    location: headers.location ?? null,
    setCookie: headers['set-cookie']?.replace(/^[a-z_]+_[0-9a-f]{8}=/, '<name>=') ?? null,
  };
}

async function throughHub(c: Case) {
  const headers = { host: HOST, ...c.headers, ...cookieHeader(accessCookieName(TOKEN), c.cookie) };
  const request = new Request(`${ORIGIN}${c.path ?? '/'}`, { method: c.method ?? 'GET', headers });
  const response = authorizeRequest(request, TOKEN, { mountPath: '', allowQueryToken: c.allowQueryToken });
  if (!response) return outcome(null, {});
  const read = (name: string) => response.headers.get(name);
  return outcome(
    response.status,
    { 'content-type': read('content-type'), location: read('location'), 'set-cookie': read('set-cookie') },
    await response.text(),
  );
}

function throughServeSim(c: Case) {
  const headers = { host: HOST, ...c.headers, ...cookieHeader(serveSimCookieName(TOKEN), c.cookie) };
  let status = 0;
  let written: Record<string, string> = {};
  let body = '';
  const res = {
    writeHead: (code: number, head: Record<string, string> = {}) => {
      status = code;
      written = Object.fromEntries(Object.entries(head).map(([name, value]) => [name.toLowerCase(), value]));
    },
    end: (text = '') => {
      body = text;
    },
  };
  const passed = assertPreviewAccess({ method: c.method ?? 'GET', url: c.path ?? '/', headers }, res, TOKEN, {
    required: true,
    basePath: '/',
    allowQueryToken: c.allowQueryToken,
  });
  if (passed) return outcome(null, {});
  return outcome(
    status,
    { 'content-type': written['content-type'] ?? null, location: written.location ?? null, 'set-cookie': written['set-cookie'] ?? null },
    body,
  );
}

const UPGRADE_CASES: Array<{ name: string; headers: Record<string, string> }> = [
  { name: 'a bearer', headers: { authorization: `Bearer ${TOKEN}` } },
  { name: 'the token subprotocol', headers: { 'sec-websocket-protocol': `serve-sim.token.${TOKEN}` } },
  { name: 'the token subprotocol among others', headers: { 'sec-websocket-protocol': `chat, serve-sim.token.${TOKEN}` } },
  { name: 'a wrong token subprotocol', headers: { 'sec-websocket-protocol': 'serve-sim.token.nope' } },
  { name: 'an empty token subprotocol', headers: { 'sec-websocket-protocol': 'serve-sim.token.' } },
  { name: "another backend's subprotocol", headers: { 'sec-websocket-protocol': `serve-emu.token.${TOKEN}` } },
  { name: 'the cookie from the same Origin', headers: { origin: ORIGIN, cookie: 'valid' } },
  { name: 'the cookie from another Origin', headers: { origin: 'http://evil.example', cookie: 'valid' } },
  { name: 'the cookie from the same site', headers: { 'sec-fetch-site': 'same-site', cookie: 'valid' } },
  { name: 'the cookie with no Origin', headers: { cookie: 'valid' } },
  { name: 'nothing', headers: {} },
];

function upgradeHeaders(headers: Record<string, string>, cookieName: string): Record<string, string> {
  const { cookie, ...rest } = headers;
  return { host: HOST, ...rest, ...(cookie ? cookieHeader(cookieName, 'valid') : {}) };
}

describe("the Hub's gate and serve-sim's gate", () => {
  for (const c of REQUEST_CASES) {
    test(`answer ${c.name} the same way`, async () => {
      expect(await throughHub(c)).toEqual(throughServeSim(c));
    });
  }

  for (const c of UPGRADE_CASES) {
    test(`answer a socket with ${c.name} the same way`, () => {
      const hub = authorizeUpgrade(
        new Request(`${ORIGIN}/exec-ws`, { headers: upgradeHeaders(c.headers, accessCookieName(TOKEN)) }),
        TOKEN,
        ['serve-sim.token.'],
      );
      const serveSim = assertUpgradeAccess(upgradeHeaders(c.headers, serveSimCookieName(TOKEN)), TOKEN, {
        required: true,
      });
      expect(hub).toBe(serveSim);
    });
  }
});
