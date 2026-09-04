import { describe, expect, test } from 'bun:test';

import { mergeAuthoritativeDeviceSetting } from '../device-setting-writes';

describe('mergeAuthoritativeDeviceSetting', () => {
  test('rolls back only the failed option without clobbering another optimistic write', () => {
    const optimistic = {
      appearance: 'dark',
      'text-size': 'xxx-large',
      'reduce-motion': 'on',
    } as const;

    expect(
      mergeAuthoritativeDeviceSetting(optimistic, 'appearance', {
        appearance: 'light',
        'text-size': 'large',
        'reduce-motion': 'off',
      }),
    ).toEqual({
      appearance: 'light',
      'text-size': 'xxx-large',
      'reduce-motion': 'on',
    });
  });

  test('removes a failed optimistic option when the authoritative status omits it', () => {
    expect(
      mergeAuthoritativeDeviceSetting(
        { appearance: 'dark', 'liquid-glass': 'on' },
        'liquid-glass',
        { appearance: 'dark' },
      ),
    ).toEqual({ appearance: 'dark' });
  });
});
