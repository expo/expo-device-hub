import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceTitle } from '../dashboard/DeviceTitle';

describe('device title', () => {
  test('caps long labels and truncates them with an ellipsis', () => {
    const name = 'A very long simulator name that should not expand the stream layout';
    const markup = renderToStaticMarkup(
      <DeviceTitle
        device={{ id: '00000000-0000-0000-0000-000000000000', name }}
        status="streaming"
      />
    );

    expect(markup).toContain('max-width:min(100%, 320px)');
    expect(markup).toContain('box-sizing:border-box');
    expect(markup).toContain('flex:1 1 auto');
    expect(markup).toContain('min-width:0');
    expect(markup).toContain('overflow:hidden');
    expect(markup).toContain('text-overflow:ellipsis');
    expect(markup).toContain('white-space:nowrap');
    expect(markup).toContain(`title="${name}"`);
  });
});
