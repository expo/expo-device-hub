import { describe, expect, test } from 'bun:test';

import { configureClientShell } from '../client-shell';

describe('configureClientShell', () => {
  const shell =
    '<base href="{{mount}}/"> <script>var platform = "{{platform}}"; var transport = "{{transport}}"; var hideSidebar = "{{hideSidebar}}"; var hideBootDevice = "{{hideBootDevice}}"</script>';
  const share = "<script>var sessionToken = '{{sessionToken}}'; var shareUrl = '{{shareUrl}}';</script>";

  test('leaves CLI options empty when they are omitted', () => {
    expect(configureClientShell(shell + share, { mountPath: '' })).toBe(
      '<base href="/"> <script>var platform = ""; var transport = ""; var hideSidebar = "false"; var hideBootDevice = "false"</script>' +
        "<script>var sessionToken = ''; var shareUrl = '';</script>"
    );
  });

  test('injects the selected options and mount path', () => {
    expect(
      configureClientShell(shell, {
        mountPath: '/hub',
        platform: 'android',
        transport: 'webrtc',
        hideSidebar: true,
        hideBootDevice: true,
      })
    ).toBe(
      '<base href="/hub/"> <script>var platform = "android"; var transport = "webrtc"; var hideSidebar = "true"; var hideBootDevice = "true"</script>'
    );
  });

  test('injects the session token and the share URL for the Share button', () => {
    expect(
      configureClientShell(share, {
        mountPath: '',
        sessionToken: 'tok-1',
        shareUrl: 'https://expo.dev/device-preview/abc',
      })
    ).toBe("<script>var sessionToken = 'tok-1'; var shareUrl = 'https://expo.dev/device-preview/abc';</script>");
  });

  // A URL path may keep a quote, so each value is escaped for the string literal it lands in.
  test('cannot end the script or the string it is injected into', () => {
    const html = configureClientShell(share, {
      mountPath: '',
      shareUrl: "https://expo.dev/it's</script><script>alert(1)</script>",
    });

    expect(html).not.toContain("it's");
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('\\u0027');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});
