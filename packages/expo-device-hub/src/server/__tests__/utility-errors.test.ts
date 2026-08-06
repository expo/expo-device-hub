import { createHash } from 'node:crypto';
import { expect, test } from 'bun:test';

import { toSerializableError } from '../utility-errors';

test('serializes an error without platform and identifies it by name, message, and stack', () => {
  const error = new Error('spawn avdmanager ENOENT');
  error.stack = 'Error: spawn avdmanager ENOENT\n    at listDevices';

  const serialized = toSerializableError({
    message: '[android-utils] Failed to run `avdmanager list avd`:',
    error,
  });
  const id = createHash('md5').update(error.name + error.message + error.stack).digest('hex');

  expect(serialized).toMatchObject({
    id,
    message: '[android-utils] Failed to run `avdmanager list avd`:',
  });
  expect(serialized).not.toHaveProperty('platform');
});
