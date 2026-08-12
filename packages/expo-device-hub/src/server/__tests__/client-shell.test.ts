import { describe, expect, test } from 'bun:test';

import { configureClientShell } from '../client-shell';

describe('configureClientShell', () => {
  const shell = '<base href="{{mount}}/"> <script>var platform = "{{platform}}"</script>';

  test('leaves the platform empty when the CLI option is omitted', () => {
    expect(configureClientShell(shell, '', undefined)).toBe(
      '<base href="/"> <script>var platform = ""</script>'
    );
  });

  test('injects the selected platform and mount path', () => {
    expect(configureClientShell(shell, '/hub', 'android')).toBe(
      '<base href="/hub/"> <script>var platform = "android"</script>'
    );
  });
});
