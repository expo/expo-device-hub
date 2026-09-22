import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { StreamControls } from '../dashboard/StreamControls';

function buttonTags(markup: string) {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

describe('StreamControls', () => {
  test('locks Rotate and explains the pending recording check', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="light" onToggleAppearance={() => {}} recording="unknown" />,
    );
    const rotate = buttonTags(markup).find((tag) => tag.includes('aria-label="Rotate"'));
    expect(rotate).toContain('aria-disabled="true"');
    expect(rotate).toContain('Rotation is unavailable until recording status is known.');
  });
  test('explains why Rotate is unavailable during recording without disabling app controls', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="light" onToggleAppearance={() => {}} recording="recording" />,
    );
    const buttons = buttonTags(markup);
    const rotate = buttons.find((tag) => tag.includes('aria-label="Rotate"'));
    expect(rotate).toContain('aria-disabled="true"');
    expect(rotate).toContain('aria-description="Rotation is unavailable while recording."');
    for (const tag of buttons.filter((tag) => !tag.includes('aria-label="Rotate"'))) {
      expect(tag).not.toContain('disabled');
    }
  });
  test('groups Save, Theme, Home, and Reload in one pill and keeps Rotate separate', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="dark" onToggleAppearance={() => {}} />
    );
    const buttons = buttonTags(markup);

    expect(buttons.map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1])).toEqual([
      'Save',
      'Theme',
      'Home',
      'Reload',
      'Rotate',
    ]);
    expect(markup).toContain('role="toolbar"');
    expect(markup).not.toContain('More');
    expect(markup).not.toContain('Shutdown');
    expect(markup).not.toContain('Remove');

    const groups = [...markup.matchAll(/<div style="[^"]*border-radius:var\(--expo-radius-xl\)[^"]*"/g)];
    expect(groups).toHaveLength(2);
    expect(markup.indexOf('aria-label="Rotate"')).toBeGreaterThan(markup.lastIndexOf('border-radius:var(--expo-radius-xl)'));
  });

  test('shows every label as a tooltip above its button and exposes Theme as a switch', () => {
    const markup = renderToStaticMarkup(
      <StreamControls appearance="dark" onToggleAppearance={() => {}} />
    );
    const tooltips = [...markup.matchAll(/<span role="tooltip"[^>]*>([^<]+)<\/span>/g)];

    expect(tooltips.map((match) => match[1])).toEqual(['Save', 'Theme', 'Home', 'Reload', 'Rotate']);
    for (const match of tooltips) {
      expect(match[0]).toContain('bottom:calc(100% + 8px)');
      expect(match[0]).toContain('opacity:0');
    }
    const theme = buttonTags(markup).find((tag) => tag.includes('aria-label="Theme"'));
    expect(theme).toContain('role="switch"');
    expect(theme).toContain('aria-checked="true"');
    for (const tag of buttonTags(markup)) {
      expect(tag).toContain('width:44px');
      expect(tag).toContain('height:44px');
    }
  });
});
