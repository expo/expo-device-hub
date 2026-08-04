import { describe, expect, test } from 'bun:test';

import { parseCreateDeviceAction } from '../device-actions';

describe('parseCreateDeviceAction', () => {
  test('accepts and trims stable toolchain identifiers', async () => {
    const request = jsonRequest({
      platform: 'ios',
      name: '  QA iPhone  ',
      runtime: '  com.apple.runtime.iOS-18-0  ',
      deviceType: '  com.apple.device.iPhone-16  ',
    });

    await expect(parseCreateDeviceAction(request)).resolves.toEqual({
      platform: 'ios',
      name: 'QA iPhone',
      runtime: 'com.apple.runtime.iOS-18-0',
      deviceType: 'com.apple.device.iPhone-16',
    });
  });

  test('rejects missing, blank, or unsupported values', async () => {
    await expect(
      parseCreateDeviceAction(
        jsonRequest({
          platform: 'android',
          name: '',
          runtime: 'android-35',
          deviceType: 'pixel_9',
        })
      )
    ).resolves.toBeNull();
    await expect(
      parseCreateDeviceAction(
        jsonRequest({ platform: 'web', name: 'Chrome', runtime: 'stable', deviceType: 'desktop' })
      )
    ).resolves.toBeNull();
    await expect(
      parseCreateDeviceAction(
        new Request('http://localhost/api/devices/create', { method: 'POST' })
      )
    ).resolves.toBeNull();
  });

  test('rejects Android AVD names containing unsupported characters', async () => {
    await expect(
      parseCreateDeviceAction(
        jsonRequest({
          platform: 'android',
          name: 'Pixel 9',
          runtime: 'system-images;android-35;google_apis;arm64-v8a',
          deviceType: 'pixel_9',
        })
      )
    ).resolves.toBeNull();

    await expect(
      parseCreateDeviceAction(
        jsonRequest({
          platform: 'android',
          name: 'Pixel_9.API-35',
          runtime: 'system-images;android-35;google_apis;arm64-v8a',
          deviceType: 'pixel_9',
        })
      )
    ).resolves.toEqual({
      platform: 'android',
      name: 'Pixel_9.API-35',
      runtime: 'system-images;android-35;google_apis;arm64-v8a',
      deviceType: 'pixel_9',
    });
  });
});

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/devices/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
