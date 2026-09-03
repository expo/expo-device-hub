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

test('follows the pointer without easing while a resize handle is dragged', () => {
  const eased = renderToStaticMarkup(
    <AnimatedDockedSidebar side="left" width={320} open sidebarOpen>
      <div />
    </AnimatedDockedSidebar>,
  );
  const dragged = renderToStaticMarkup(
    <AnimatedDockedSidebar side="left" width={320} open sidebarOpen resizing>
      <div />
    </AnimatedDockedSidebar>,
  );

  expect(eased).toContain('transition:width');
  expect(dragged).not.toContain('transition:width');
  expect(dragged).toContain('width:320px');
});
