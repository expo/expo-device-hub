import { describe, expect, test } from 'bun:test';

import {
  androidCameraErrorMessage,
  androidCameraImageUrl,
  parseAndroidCamera,
} from '../android-camera';
import { type CameraFacing } from '../types';

const imageUrlFor = (facing: CameraFacing, digest: string | null) =>
  androidCameraImageUrl('http://hub.test/_expo/plugins/serve-emu', 'emulator-5554', facing, digest);

function payload(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    camera: {
      serial: 'emulator-5554',
      supported: true,
      wiredAtLaunch: true,
      launchArgs: ['-camera-back', 'webcam0'],
      feeds: [
        {
          facing: 'front',
          path: '/tmp/front.png',
          present: true,
          placeholder: false,
          width: 640,
          height: 480,
          bytes: 1024,
          digest: 'aaa',
          updatedAt: '2026-09-04T10:00:00.000Z',
        },
        {
          facing: 'back',
          path: '/tmp/back.png',
          present: false,
          placeholder: true,
          width: null,
          height: null,
          bytes: null,
          digest: null,
          updatedAt: null,
        },
      ],
      ...overrides,
    },
  };
}

describe('parseAndroidCamera', () => {
  test('parses a full payload and orders feeds back-first', () => {
    const parsed = parseAndroidCamera(payload(), imageUrlFor);
    expect(parsed).toEqual({
      wiredAtLaunch: true,
      launchArgs: ['-camera-back', 'webcam0'],
      feeds: [
        {
          facing: 'back',
          present: false,
          placeholder: true,
          width: null,
          height: null,
          bytes: null,
          updatedAt: null,
          imageUrl: null,
        },
        {
          facing: 'front',
          present: true,
          placeholder: false,
          width: 640,
          height: 480,
          bytes: 1024,
          updatedAt: '2026-09-04T10:00:00.000Z',
          imageUrl: imageUrlFor('front', 'aaa'),
        },
      ],
    });
  });

  test('returns null when the backend reports the camera unsupported', () => {
    expect(parseAndroidCamera(payload({ supported: false }), imageUrlFor)).toBeNull();
  });

  test('returns null when the response is not ok', () => {
    expect(
      parseAndroidCamera({ ...payload(), ok: false }, imageUrlFor),
    ).toBeNull();
  });

  test('rejects a feed with an unknown facing', () => {
    expect(
      parseAndroidCamera(
        payload({ feeds: [{ ...payload().camera.feeds[0], facing: 'external' }] }),
        imageUrlFor,
      ),
    ).toBeNull();
  });

  test('rejects a non-boolean placeholder', () => {
    expect(
      parseAndroidCamera(
        payload({ feeds: [{ ...payload().camera.feeds[0], placeholder: 'no' }] }),
        imageUrlFor,
      ),
    ).toBeNull();
  });

  test('rejects a non-numeric width', () => {
    expect(
      parseAndroidCamera(
        payload({ feeds: [{ ...payload().camera.feeds[0], width: '640' }] }),
        imageUrlFor,
      ),
    ).toBeNull();
  });

  test('leaves imageUrl null for an absent feed', () => {
    const parsed = parseAndroidCamera(payload(), imageUrlFor);
    expect(parsed?.feeds.find((feed) => feed.facing === 'back')?.imageUrl).toBeNull();
  });
});

describe('androidCameraImageUrl', () => {
  test('versions the URL with the digest', () => {
    const url = new URL(imageUrlFor('front', 'abc123'));
    expect(url.searchParams.get('v')).toBe('abc123');
    expect(url.searchParams.get('facing')).toBe('front');
    expect(url.searchParams.get('device')).toBe('emulator-5554');
  });

  test('omits the version when there is no digest', () => {
    expect(new URL(imageUrlFor('back', null)).searchParams.has('v')).toBe(false);
  });

  test('preserves the Hub mount prefix', () => {
    expect(new URL(imageUrlFor('back', null)).pathname).toBe(
      '/_expo/plugins/serve-emu/api/camera/image',
    );
  });
});

describe('androidCameraErrorMessage', () => {
  test('reads the error string from a rejected write', () => {
    expect(androidCameraErrorMessage({ ok: false, error: ' Only PNG images. ' })).toBe(
      'Only PNG images.',
    );
  });

  test('returns null when there is no error string', () => {
    expect(androidCameraErrorMessage({ ok: false })).toBeNull();
    expect(androidCameraErrorMessage(null)).toBeNull();
  });
});
