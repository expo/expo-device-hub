import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarOverlay } from '../SidebarOverlay';

test('keeps content beneath a sidebar overlay visible', () => {
  const html = renderToStaticMarkup(
    <SidebarOverlay side="left" open sidebarOpen topmost onDismiss={() => {}}>
      <div>Sidebar</div>
    </SidebarOverlay>
  );

  expect(html).toContain('data-sidebar-backdrop="left"');
  expect(html).toContain('opacity:0.35');
  expect(html).toContain('transform:translateX(0)');
});

test('separates a slide-over sidebar from the content with a hairline instead of a shadow', () => {
  const left = renderToStaticMarkup(
    <SidebarOverlay side="left" open sidebarOpen topmost onDismiss={() => {}}>
      <div />
    </SidebarOverlay>,
  );
  const right = renderToStaticMarkup(
    <SidebarOverlay side="right" open sidebarOpen topmost onDismiss={() => {}}>
      <div />
    </SidebarOverlay>,
  );

  const panel = (html: string) => {
    const start = html.indexOf('data-sidebar-overlay=');
    return html.slice(html.lastIndexOf('<div', start), html.indexOf('>', start) + 1);
  };

  expect(panel(left)).toContain('border-right:1px solid var(--expo-theme-border-default)');
  expect(panel(left)).not.toContain('box-shadow');
  expect(panel(right)).toContain('border-left:1px solid var(--expo-theme-border-default)');
  expect(panel(right)).not.toContain('box-shadow');
});
