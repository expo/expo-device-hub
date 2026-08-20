import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AnimatedDockedSidebar } from '../AnimatedDockedSidebar';

test('occupies its width while an animated docked sidebar is open', () => {
  const html = renderToStaticMarkup(
    <AnimatedDockedSidebar side="right" width={400} open sidebarOpen>
      <div>Sidebar</div>
    </AnimatedDockedSidebar>
  );

  expect(html).toContain('data-sidebar-docked="right"');
  expect(html).toContain('width:400px');
  expect(html).toContain('transform:translateX(0)');
});
