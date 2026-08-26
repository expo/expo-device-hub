import { expect, test } from 'bun:test';
import { LogSidebar, Sidebar } from '@expo/hub-components';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FloatingSidebarToggle,
  floatingSidebarToggleInset,
} from '../FloatingSidebarToggle';

function inlinePixels(style: string, property: string): number {
  const match = style.match(new RegExp(`${property}:([\\d.]+)px`));
  if (!match) throw new Error(`Missing ${property} in inline style: ${style}`);
  return Number(match[1]);
}

test('keeps its vertical position while moving sideways to avoid a collision', () => {
  const html = renderToStaticMarkup(
    <FloatingSidebarToggle side="right" inset={80} onClick={() => {}} />
  );

  expect(html).toContain('top:28px');
  expect(html).toContain('right:80px');
  expect(html).not.toContain('top:80px');
});

test('only moves sideways when the opposite overlay controls would collide', () => {
  expect(floatingSidebarToggleInset(false, 390, 400)).toBe(24);
  expect(floatingSidebarToggleInset(true, 600, 400)).toBe(24);
  expect(floatingSidebarToggleInset(true, 390, 400)).toBe(80);
});

test('aligns a collapsed sidebar toggle with the open overlay toggle on mobile', () => {
  const floatingHtml = renderToStaticMarkup(
    <FloatingSidebarToggle side="left" inset={80} onClick={() => {}} />
  );
  const openSidebarHtml = [
    renderToStaticMarkup(<LogSidebar onToggle={() => {}} />),
    renderToStaticMarkup(
      <Sidebar
        simulators={[]}
        emulators={[]}
        recentSimulators={[]}
        recentEmulators={[]}
        simulatorOptions={{ runtimes: [] }}
        emulatorOptions={{ runtimes: [] }}
        selectedId=""
        onSelect={() => {}}
        onAddDevice={async () => ({ ok: true })}
        onToggle={() => {}}
      />
    ),
  ];

  const floatingWrapperStyle = floatingHtml.match(
    /data-floating-sidebar-toggle="left" style="([^"]+)"/
  )?.[1];
  const floatingButtonStyle = floatingHtml.match(/<button[^>]+style="([^"]+)"/)?.[1];

  expect(floatingWrapperStyle).toBeDefined();
  expect(floatingButtonStyle).toBeDefined();

  const floatingCenter =
    inlinePixels(floatingWrapperStyle!, 'top') + inlinePixels(floatingButtonStyle!, 'height') / 2;

  for (const html of openSidebarHtml) {
    const openSidebarStyle = html.match(/<aside style="([^"]+)"/)?.[1];
    const openButtonStyle = html.match(/<button[^>]+style="([^"]+)"/)?.[1];
    expect(openSidebarStyle).toBeDefined();
    expect(openButtonStyle).toBeDefined();

    const openSidebarCenter =
      inlinePixels(openSidebarStyle!, 'padding') + inlinePixels(openButtonStyle!, 'height') / 2;
    expect(floatingCenter).toBe(openSidebarCenter);
  }
});
