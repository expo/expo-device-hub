import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ScreenshotArtifactNotice } from '../dashboard/StreamPanel';

describe('ScreenshotArtifactNotice', () => {
  test('confirms a screenshot that reached the session artifacts', () => {
    const markup = renderToStaticMarkup(
      <ScreenshotArtifactNotice artifact={{ status: 'saved' }} />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('>Saved to session artifacts</span>');
    expect(markup).toContain('color:var(--expo-theme-text-tertiary)');
  });

  test('warns with the reason when the save failed', () => {
    const markup = renderToStaticMarkup(
      <ScreenshotArtifactNotice
        artifact={{ status: 'failed', error: 'ENOSPC: no space left on device' }}
      />,
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain(
      '>Downloaded. Not saved to session artifacts: ENOSPC: no space left on device</span>',
    );
    expect(markup).toContain('color:var(--expo-theme-text-warning)');
    expect(
      renderToStaticMarkup(<ScreenshotArtifactNotice artifact={{ status: 'failed' }} />),
    ).toContain('>Downloaded. Not saved to session artifacts</span>');
  });

  test('renders nothing outside a session, for an older backend, or before a screenshot', () => {
    expect(
      renderToStaticMarkup(<ScreenshotArtifactNotice artifact={{ status: 'disabled' }} />),
    ).toBe('');
    expect(renderToStaticMarkup(<ScreenshotArtifactNotice artifact={null} />)).toBe('');
  });
});
