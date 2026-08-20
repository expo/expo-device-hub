import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SidebarOverlay } from '../SidebarOverlay';

test('keeps content beneath a sidebar overlay visible', () => {
  const html = renderToStaticMarkup(
    <SidebarOverlay side="left" topmost onDismiss={() => {}}>
      <div>Sidebar</div>
    </SidebarOverlay>
  );

  expect(html).toContain('data-sidebar-backdrop="left"');
  expect(html).toContain('opacity:0.35');
});
