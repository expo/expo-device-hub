import { describe, expect, test } from 'bun:test';
import { type DeviceActivity } from '@expo/hub-client';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActivitySectionContent } from '../dashboard/ActivitySection';

function sample(bundleId: string | null = 'dev.expo.example') {
  return {
    t: 1,
    bundleId,
    cpuPct: 42,
    memBytes: 128 * 1024 ** 2,
    netInBytesPerSec: 12 * 1024,
    netOutBytesPerSec: 4 * 1024,
  };
}

describe('ActivitySection', () => {
  test.each([
    {
      name: 'the backend is measuring aggregate activity',
      activity: {
        hostCores: 8,
        samples: [sample(null)],
        errored: false,
        stale: false,
      },
      explanation: 'Only your app is measured. Open your app to see activity.',
    },
    {
      name: 'the stream is stale',
      activity: {
        hostCores: 8,
        samples: [sample()],
        errored: false,
        stale: true,
      },
      explanation: 'Activity data is paused. Waiting for live data.',
    },
    {
      name: 'the stream errors',
      activity: {
        hostCores: 8,
        samples: [sample()],
        errored: true,
        stale: false,
      },
      explanation: 'The activity stream disconnected.',
    },
  ] satisfies Array<{
    name: string;
    activity: DeviceActivity;
    explanation: string;
  }>)('keeps mocked graphs behind an explanation when $name', ({ activity, explanation }) => {
    const html = renderToStaticMarkup(<ActivitySectionContent activity={activity} />);

    expect(html).toContain('data-activity-placeholder="true"');
    expect(html).toContain('data-activity-mock="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`role="${activity.errored ? 'alert' : 'status'}"`);
    expect(html).toContain(explanation);
    expect(html.match(/role="img"/g)).toHaveLength(3);
    expect(html).toContain('\u00a0');
    expect(html).not.toContain('42%');
  });

  test('scales CPU history to its observed peak and shows core count only as context', () => {
    const activity: DeviceActivity = {
      hostCores: 8,
      samples: [
        { ...sample(), t: 0, cpuPct: 10 },
        { ...sample(), t: 1, cpuPct: 50 },
      ],
      errored: false,
      stale: false,
    };

    const html = renderToStaticMarkup(<ActivitySectionContent activity={activity} />);

    expect(html).toContain('d="M 0.00 21.80 L 100.00 1.00"');
    expect(html).toContain('8 cores');
    expect(html).not.toContain('Up to 800%');
  });
});
