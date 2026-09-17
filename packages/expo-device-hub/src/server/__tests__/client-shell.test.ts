import { describe, expect, test } from 'bun:test';

import { configureClientShell, isClientShellRequest } from '../client-shell';

describe('client shell routes', () => {
  test('serves the dashboard for root and direct iOS or Android device links', () => {
    for (const path of [
      '/',
      '/index.html',
      '/device/A05B3DB4-425C-40EC-96F1-5F05AD5FB660',
      '/device/emulator-5554',
      '/device/192.168.1.10%3A5555/',
    ]) {
      expect(isClientShellRequest(new Request(`http://localhost${path}`))).toBe(true);
    }
  });

  test('does not intercept API, asset, vendor, or non-GET requests', () => {
    for (const path of [
      '/api/devices',
      '/assets/device.png',
      '/vendor/serve-sim/device/id',
      '/device/',
      '/device/id/extra',
    ]) {
      expect(isClientShellRequest(new Request(`http://localhost${path}`))).toBe(false);
    }
    expect(
      isClientShellRequest(new Request('http://localhost/device/ios-id', { method: 'POST' }))
    ).toBe(false);
  });

  test('reloads mounted device links with assets resolved under the plugin mount', () => {
    const mount = '/_expo/plugins/expo-device-hub';
    const url = new URL(`http://localhost${mount}/device/ios-id`);
    // The host passes the request to the plugin after stripping its mount.
    url.pathname = url.pathname.slice(mount.length);
    expect(isClientShellRequest(new Request(url))).toBe(true);
    const html = configureClientShell(
      '<base href="{{mount}}/"><script src="_expo/static/js/web/app.js"></script>',
      mount,
      undefined,
      undefined,
      false,
      false
    );
    const base = html.match(/<base href="([^"]+)"/)![1];
    expect(new URL('_expo/static/js/web/app.js', new URL(base, url)).pathname).toBe(
      `${mount}/_expo/static/js/web/app.js`
    );
  });
});

describe('configureClientShell', () => {
  const shell =
    '<base href="{{mount}}/"> <script>var platform = "{{platform}}"; var transport = "{{transport}}"; var hideSidebar = "{{hideSidebar}}"; var hideBootDevice = "{{hideBootDevice}}"</script>';

  test('leaves CLI options empty when they are omitted', () => {
    expect(configureClientShell(shell, '', undefined, undefined, false, false)).toBe(
      '<base href="/"> <script>var platform = ""; var transport = ""; var hideSidebar = "false"; var hideBootDevice = "false"</script>'
    );
  });

  test('injects the selected options and mount path', () => {
    expect(configureClientShell(shell, '/hub', 'android', 'webrtc', true, true)).toBe(
      '<base href="/hub/"> <script>var platform = "android"; var transport = "webrtc"; var hideSidebar = "true"; var hideBootDevice = "true"</script>'
    );
  });
});
