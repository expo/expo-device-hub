import { expect, spyOn, test } from 'bun:test';

import { logUtilityErrors } from '../utilityErrors';

test('logs each returned utility error once while it remains active', () => {
  const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  const error = {
    id: 'Error:spawn avdmanager ENOENT',
    message: '[android-utils] Failed to run `avdmanager list avd`:',
    error: 'Error: spawn avdmanager ENOENT',
  };

  let active = logUtilityErrors([error, error]);
  expect(errorSpy).toHaveBeenCalledTimes(1);

  active = logUtilityErrors([error], active);
  expect(errorSpy).toHaveBeenCalledTimes(1);

  active = logUtilityErrors([], active);
  logUtilityErrors([error], active);
  expect(errorSpy).toHaveBeenCalledTimes(2);

  errorSpy.mockRestore();
});
