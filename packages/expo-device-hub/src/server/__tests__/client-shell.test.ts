import { describe, expect, test } from 'bun:test';

import { configureClientShell } from '../client-shell';

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
