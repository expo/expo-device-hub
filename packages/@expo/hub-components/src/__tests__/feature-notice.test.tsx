import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  EMPTY_CLIENT,
  testError,
  testFeature,
} from '../../../hub-client/src/__tests__/feature-fixture';
import { FeatureNotice } from '../dashboard/FeatureNotice';
import { DeviceOptionsSection } from '../dashboard/DeviceOptionsSection';
import type { DeviceClient, Feature } from '@expo/hub-client';

for (const [status, message] of [
  ['resolving', 'Checking availability…'],
  ['loading', 'Loading…'],
] as const) {
  test(`${status} shows the corresponding loading message`, () => {
    const feature: Feature<unknown> = { status, data: undefined, error: null, refresh() {} };
    expect(renderToStaticMarkup(<FeatureNotice feature={feature} />)).toContain(message);
  });
}

test('refresh keeps the current settings visible and announces progress', () => {
  const client: DeviceClient = {
    ...EMPTY_CLIENT,
    deviceSettings: {
      ...EMPTY_CLIENT.deviceSettings,
      status: 'loading',
      data: { values: { appearance: 'dark' }, displayWidthDp: null },
      error: null,
    },
  };
  const html = renderToStaticMarkup(<DeviceOptionsSection client={client} />);
  expect(html).toContain('Refreshing…');
  expect(html).toContain('Dark');
  expect(html).toContain('disabled=""');
});

test('terminal read failure offers retry and preserves previously loaded controls', () => {
  const client: DeviceClient = {
    ...EMPTY_CLIENT,
    deviceSettings: {
      ...EMPTY_CLIENT.deviceSettings,
      status: 'error',
      data: { values: { appearance: 'dark' }, displayWidthDp: null },
      error: testError('Device offline'),
    },
  };
  const html = renderToStaticMarkup(<DeviceOptionsSection client={client} />);
  expect(html).toContain('Device offline');
  expect(html).toContain('Retry');
  expect(html).toContain('Dark');
});

test('automatic retry is distinct from a manual retry action', () => {
  const feature: Feature<unknown> = {
    status: 'reconnecting',
    data: undefined,
    error: testError('Offline'),
    refresh() {},
  };
  const html = renderToStaticMarkup(<FeatureNotice feature={feature} />);
  expect(html).toContain('Retrying…');
  expect(html).not.toContain('<button');
});

test('unsupported and ready features need no loading or error notice', () => {
  expect(renderToStaticMarkup(<FeatureNotice feature={EMPTY_CLIENT.camera} />)).toBe('');
  expect(renderToStaticMarkup(<FeatureNotice feature={testFeature([])} />)).toBe('');
});
