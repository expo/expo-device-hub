import { describe, expect, test } from 'bun:test';

import { configureClientShell } from '../client-shell';

describe('configureClientShell', () => {
  const shell =
    '<base href="{{mount}}/"> <script>var platform = "{{platform}}"; var transport = "{{transport}}"</script>';

  test('leaves CLI options empty when they are omitted', () => {
    expect(configureClientShell(shell, '', undefined, undefined)).toBe(
      '<base href="/"> <script>var platform = ""; var transport = ""</script>'
    );
  });

  test('injects the selected options and mount path', () => {
    expect(configureClientShell(shell, '/hub', 'android', 'webrtc')).toBe(
      '<base href="/hub/"> <script>var platform = "android"; var transport = "webrtc"</script>'
    );
  });
});
