import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { type ScreenshotArtifact } from '@expo/hub-client';
import { artifactNotice, ScreenshotToast, type ScreenshotToastState } from '../dashboard/ScreenshotToast';

const noop = () => {};

function render(toast: ScreenshotToastState | null): string {
  return renderToStaticMarkup(
    <ScreenshotToast toast={toast} onDownloadAgain={noop} onPause={noop} onResume={noop} />,
  );
}

function saved(artifact: ScreenshotArtifact | null): ScreenshotToastState {
  return { phase: 'saved', id: 1, url: 'blob:http://hub/shot', filename: 'Pixel-10.png', artifact };
}

describe('ScreenshotToast', () => {
  test('shows the thumbnail, the download action, and the saved artifact', () => {
    const markup = render(saved({ status: 'saved' }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('<img src="blob:http://hub/shot"');
    expect(markup).toContain('>Screenshot saved</span>');
    expect(markup).toContain('>Download again</span>');
    expect(markup).toContain('>Saved to session artifacts</span>');
    expect(markup).toContain('<button type="button" aria-label="Download screenshot again"');
  });

  test('warns with the reason when the artifact save failed', () => {
    const markup = render(saved({ status: 'failed', error: 'ENOSPC: no space left on device' }));
    expect(markup).toContain(
      '>Downloaded. Not saved to session artifacts: ENOSPC: no space left on device</span>',
    );
    expect(markup).toContain('color:var(--expo-theme-text-warning)');
  });

  test('omits the artifact line outside a session and for an older backend', () => {
    for (const artifact of [{ status: 'disabled' } as const, null]) {
      const markup = render(saved(artifact));
      expect(markup).toContain('>Screenshot saved</span>');
      expect(markup).not.toContain('session artifacts');
    }
  });

  test('shows an empty thumbnail and no action while capturing', () => {
    const markup = render({ phase: 'capturing', id: 1 });
    expect(markup).toContain('>Capturing screenshot…</span>');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('<button');
  });

  test('reports a failed capture without an action', () => {
    const markup = render({ phase: 'capture-failed', id: 1 });
    expect(markup).toContain('>Screenshot failed</span>');
    expect(markup).not.toContain('<button');
  });

  test('renders nothing without a toast', () => {
    expect(render(null)).toBe('');
  });
});

describe('artifactNotice', () => {
  test('keeps a failed save on screen long enough to read the reason', () => {
    expect(artifactNotice({ status: 'saved' })).toEqual({
      message: 'Saved to session artifacts',
      dismissMs: 3500,
    });
    expect(artifactNotice({ status: 'failed', error: 'ENOSPC' })).toEqual({
      message: 'Downloaded. Not saved to session artifacts: ENOSPC',
      dismissMs: 12_000,
    });
    expect(artifactNotice({ status: 'failed' })).toEqual({
      message: 'Downloaded. Not saved to session artifacts',
      dismissMs: 12_000,
    });
    expect(artifactNotice({ status: 'disabled' })).toEqual({ dismissMs: 3500 });
    expect(artifactNotice(null)).toEqual({ dismissMs: 3500 });
  });
});
