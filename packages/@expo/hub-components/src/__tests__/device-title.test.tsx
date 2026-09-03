import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { DeviceTitle } from '../dashboard/DeviceTitle';

describe('device title', () => {
  test('keeps the status visible when a long label needs truncating', () => {
    const name = '868BF88E-084A-4E9D-9434-C2D3C0C567F3';
    const markup = renderToStaticMarkup(
      <DeviceTitle
        device={{ id: '00000000-0000-0000-0000-000000000000', name }}
        status="streaming"
      />
    );
    const buttonContent = markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</button>'));

    expect(buttonContent).toStartWith(`<span title="${name}"`);
    expect(markup).toContain('max-width:min(100%, 320px)');
    expect(markup).toContain('box-sizing:border-box');
    expect(markup).toContain('flex:1 1 auto');
    expect(markup).toContain('min-width:0');
    expect(markup).toContain('overflow:hidden');
    expect(markup).toContain('text-overflow:ellipsis');
    expect(markup).toContain('white-space:nowrap');
    expect(markup).toContain(`title="${name}"`);
  });

  test('labels a live stream that is re-establishing its transport', () => {
    const markup = renderToStaticMarkup(
      <DeviceTitle device={{ id: 'emulator-5554', name: 'Pixel' }} status="reconnecting" />
    );

    expect(markup).toContain('>Reconnecting</span>');
    expect(markup).not.toContain('>Error</span>');
  });
});
