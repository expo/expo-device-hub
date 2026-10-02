import { describe, expect, test } from 'bun:test';

import {
  httpToWebSocketUrl,
  publicServeSimMount,
  publicUrlForAdvertisedPath,
  publicUrlForRoute,
  routeWithoutServerBasePath,
} from '../serve-sim-urls';

describe('publicServeSimMount', () => {
  test('resolves a relative mount against the page', () => {
    expect(publicServeSimMount('/vendor/serve-sim', 'http://localhost:8081/index').href).toBe(
      'http://localhost:8081/vendor/serve-sim/',
    );
  });

  test('keeps a remote mount, adds one trailing slash and drops query and hash', () => {
    expect(
      publicServeSimMount('https://sim.example.test:8443/preview/session//?x=1#y', 'https://example.com/')
        .href,
    ).toBe('https://sim.example.test:8443/preview/session/');
  });

  test('resolves an absolute mount without a page URL', () => {
    expect(publicServeSimMount('https://sim.example.test').href).toBe('https://sim.example.test/');
  });
});

describe('publicUrlForRoute', () => {
  const mount = new URL('https://sim.example.test/preview/session/');

  test('joins routes under the mount, with or without a leading slash', () => {
    expect(publicUrlForRoute(mount, 'grid/api')).toBe(
      'https://sim.example.test/preview/session/grid/api',
    );
    expect(publicUrlForRoute(mount, '/grid/api')).toBe(
      'https://sim.example.test/preview/session/grid/api',
    );
  });

  test('keeps the route query and adds non-empty query values', () => {
    expect(publicUrlForRoute(mount, 'ax?device=A')).toBe(
      'https://sim.example.test/preview/session/ax?device=A',
    );
    expect(publicUrlForRoute(mount, 'api', { device: 'DEVICE A/B' })).toBe(
      'https://sim.example.test/preview/session/api?device=DEVICE+A%2FB',
    );
    expect(publicUrlForRoute(mount, 'api', { device: null })).toBe(
      'https://sim.example.test/preview/session/api',
    );
  });

  test('does not read a route with a colon as a URL scheme', () => {
    expect(publicUrlForRoute(mount, 'a:b')).toBe('https://sim.example.test/preview/session/a:b');
  });
});

describe('routeWithoutServerBasePath', () => {
  test('removes the server base path and keeps the query', () => {
    expect(routeWithoutServerBasePath('/internal/logs?device=DEVICE%20A', '/internal')).toBe(
      'logs?device=DEVICE%20A',
    );
    expect(routeWithoutServerBasePath('/internal', '/internal/')).toBe('');
  });

  test('ignores the host of a full advertised URL', () => {
    expect(
      routeWithoutServerBasePath('http://127.0.0.1:3200/internal/ax?device=DEVICE-A', '/internal'),
    ).toBe('ax?device=DEVICE-A');
  });

  test('keeps routes of a root-mounted server', () => {
    expect(routeWithoutServerBasePath('/grid/api', '')).toBe('grid/api');
    expect(routeWithoutServerBasePath('appstate?device=DEVICE-A', '')).toBe(
      'appstate?device=DEVICE-A',
    );
  });

  test('keeps a path that does not start with the base path', () => {
    expect(routeWithoutServerBasePath('/ax?device=DEVICE-A', '/internal')).toBe('ax?device=DEVICE-A');
    expect(routeWithoutServerBasePath('/internalx/ax', '/internal')).toBe('internalx/ax');
  });
});

describe('publicUrlForAdvertisedPath', () => {
  test('moves an advertised route onto the public mount', () => {
    expect(
      publicUrlForAdvertisedPath(
        new URL('https://sim.example.test:8443/preview/session/'),
        '/internal/ax?device=DEVICE-A',
        '/internal',
      ),
    ).toBe('https://sim.example.test:8443/preview/session/ax?device=DEVICE-A');
  });

  test('strips only the server base path, even when a route starts like the public mount', () => {
    // A root-mounted server exposed under /grid owns its own /grid/api route.
    const gridMount = new URL('https://sim.example.test/grid/');
    expect(publicUrlForAdvertisedPath(gridMount, '/grid/api', '')).toBe(
      'https://sim.example.test/grid/grid/api',
    );
  });
});

test('httpToWebSocketUrl changes http to ws and https to wss', () => {
  expect(httpToWebSocketUrl('http://localhost:3200/exec-ws')).toBe('ws://localhost:3200/exec-ws');
  expect(httpToWebSocketUrl('https://sim.example.test/exec-ws')).toBe('wss://sim.example.test/exec-ws');
});
