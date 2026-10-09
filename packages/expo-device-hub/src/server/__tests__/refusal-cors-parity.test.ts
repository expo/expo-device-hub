import { describe, expect, test } from 'bun:test';

// The backends' own rules, read from their sources. The Hub copies them for its token refusal.
import { isAllowedBrowserOrigin } from '../../../../serve-emu/packages/serve-emu/src/origin-policy';
import { corsAllowOriginHeaders } from '../../../../serve-sim/packages/serve-sim/src/middleware-utils';
import { serveEmuAllowsOrigin } from '../serve-emu-options';
import { serveSimAllowsOrigin } from '../serve-sim-options';

const CORS_ORIGINS = ['https://page.example', 'https://*.expo.dev'];
const PAGES = [
  'https://page.example',
  'https://elsewhere.example',
  'http://localhost:5173',
  'http://preview.localhost:5173',
  'http://127.0.0.1:5173',
  'http://127.0.0.2:5173',
  'http://[::1]:5173',
  'http://127.example.com:5173',
  'http://192.168.1.20:3400',
  'https://pr-12.expo.dev',
  'https://a.b.expo.dev',
  'https://expo.dev',
  'http://pr-12.expo.dev',
  'https://pr-12.expo.dev:8443',
  'https://evilexpo.dev',
];
const HUBS = [
  'http://127.0.0.1:3400',
  'http://127.0.0.2:3400',
  'http://localhost:3400',
  'http://hub.localhost:3400',
  'http://[::1]:3400',
  'http://192.168.1.20:3400',
];

// A refusal that names fewer pages leaves an allowed page with a network error; one that names
// more lets a page read what the backend would hide from it.
describe("the Hub's refusal names the pages each backend names", () => {
  test('serve-emu', () => {
    for (const hub of HUBS) {
      for (const page of PAGES) {
        const request = new Request(`${hub}/api/devices`, { headers: { Origin: page } });
        expect([hub, page, serveEmuAllowsOrigin(CORS_ORIGINS, new URL(page), request)]).toEqual([
          hub,
          page,
          isAllowedBrowserOrigin(request, { allowedOrigins: CORS_ORIGINS }),
        ]);
      }
    }
  });

  test('serve-sim', () => {
    for (const page of PAGES) {
      expect([page, serveSimAllowsOrigin(CORS_ORIGINS, new URL(page))]).toEqual([
        page,
        'Access-Control-Allow-Origin' in corsAllowOriginHeaders(page, CORS_ORIGINS),
      ]);
    }
  });
});
