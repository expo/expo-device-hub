import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FloatingSidebarToggle,
  floatingSidebarToggleInset,
} from '../FloatingSidebarToggle';

test('keeps its vertical position while moving sideways to avoid a collision', () => {
  const html = renderToStaticMarkup(
    <FloatingSidebarToggle side="right" inset={80} onClick={() => {}} />
  );

  expect(html).toContain('top:24px');
  expect(html).toContain('right:80px');
  expect(html).not.toContain('top:80px');
});

test('only moves sideways when the opposite overlay controls would collide', () => {
  expect(floatingSidebarToggleInset(false, 390, 400)).toBe(24);
  expect(floatingSidebarToggleInset(true, 600, 400)).toBe(24);
  expect(floatingSidebarToggleInset(true, 390, 400)).toBe(80);
});
