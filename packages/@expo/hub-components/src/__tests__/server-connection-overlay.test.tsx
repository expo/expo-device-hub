import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ServerConnectionOverlay,
  temporarilyInertElement,
} from '../dashboard/ServerConnectionOverlay';
import { font } from '../theme/tokens';

describe('ServerConnectionOverlay', () => {
  test('renders above shared portals with the typed font token', () => {
    const markup = renderToStaticMarkup(
      <ServerConnectionOverlay status="disconnected" onReload={() => {}} />,
    );
    const overlayTag = markup.slice(0, markup.indexOf('>') + 1);

    expect(overlayTag).toContain('role="alertdialog"');
    expect(overlayTag).toContain('aria-modal="true"');
    expect(overlayTag).toContain('aria-labelledby="server-connection-overlay-title"');
    expect(overlayTag).toContain('aria-describedby="server-connection-overlay-description"');
    expect(overlayTag).toContain('z-index:610');
    expect(overlayTag).toContain('pointer-events:auto');
    expect(overlayTag).toContain(`font-family:${font.sans}`);
  });

  test('temporarily makes a portal inert without changing an existing blocker', () => {
    const portal = { inert: false };
    const restore = temporarilyInertElement(portal);

    expect(portal.inert).toBeTrue();
    expect(restore).not.toBeNull();
    restore?.();
    expect(portal.inert).toBeFalse();

    const alreadyInert = { inert: true };
    expect(temporarilyInertElement(alreadyInert)).toBeNull();
    expect(alreadyInert.inert).toBeTrue();
  });
});
