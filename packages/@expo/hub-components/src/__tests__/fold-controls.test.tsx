import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { StreamControls } from '../dashboard/StreamControls';

function buttonTags(markup: string) {
  return [...markup.matchAll(/<button[^>]*>/g)].map((match) => match[0]);
}

describe('StreamControls fold presets', () => {
  test('offers the three everyday fold positions in a third pill after Rotate', () => {
    const markup = renderToStaticMarkup(
      <StreamControls
        appearance="light"
        onToggleAppearance={() => {}}
        hinge={{ angle: 0, pose: 'closed', onChange: () => {} }}
      />,
    );
    const labels = buttonTags(markup).map((tag) => tag.match(/aria-label="([^"]+)"/)?.[1]);
    expect(labels).toEqual([
      'Save',
      'Theme',
      'Home',
      'Reload',
      'Rotate',
      'Fully folded',
      'Partially open',
      'Fully open',
    ]);
    expect(markup).toContain('aria-label="Fold position"');
    expect(markup).not.toContain('Laptop');
    expect(markup).not.toContain('Tent');
    const groups = [...markup.matchAll(/border-radius:var\(--expo-radius-xl\)/g)];
    expect(groups).toHaveLength(3);
    expect(markup.indexOf('aria-label="Fully folded"')).toBeGreaterThan(markup.indexOf('aria-label="Rotate"'));
  });

  test('presses the reported pose and names the Option+Shift shortcuts', () => {
    const markup = renderToStaticMarkup(
      <StreamControls
        appearance="light"
        onToggleAppearance={() => {}}
        hinge={{ angle: 90, pose: 'book', onChange: () => {} }}
      />,
    );
    const pressed = buttonTags(markup).filter((tag) => tag.includes('aria-pressed="true"'));
    expect(pressed).toHaveLength(1);
    expect(pressed[0]).toContain('aria-label="Partially open"');
    expect(markup).toContain('Fully folded (⌥⇧1)');
    expect(markup).toContain('Partially open (⌥⇧4)');
    expect(markup).toContain('Fully open (⌥⇧2)');
  });

  test('infers the endpoints only until a pose is reported, and a custom angle presses nothing', () => {
    const inferred = renderToStaticMarkup(
      <StreamControls appearance="light" onToggleAppearance={() => {}} hinge={{ angle: 180, onChange: () => {} }} />,
    );
    expect(inferred).toMatch(/aria-label="Fully open"[^>]*aria-pressed="true"/);
    for (const hinge of [
      { angle: 180, pose: null },
      { angle: 90, pose: 'laptop' as const },
      { angle: 42 },
    ]) {
      const markup = renderToStaticMarkup(
        <StreamControls appearance="light" onToggleAppearance={() => {}} hinge={{ ...hinge, onChange: () => {} }} />,
      );
      expect(markup).not.toContain('aria-pressed="true"');
    }
  });

  test('keeps the presets available while a change is pending', () => {
    const markup = renderToStaticMarkup(
      <StreamControls
        appearance="light"
        onToggleAppearance={() => {}}
        hinge={{ angle: 90, pending: true, onChange: () => {} }}
      />,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toMatch(/<button[^>]* disabled=""/);
  });

  test('shows no fold controls for a device without a hinge', () => {
    const markup = renderToStaticMarkup(<StreamControls appearance="light" onToggleAppearance={() => {}} />);
    expect(markup).not.toContain('Fold position');
    expect(buttonTags(markup)).toHaveLength(5);
  });
});
