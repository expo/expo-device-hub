import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AgentInteractionIndicator } from '../AgentInteractionIndicator';
import {
  DEVICE_POINTER_LABEL_STYLE,
  devicePointerLabelRadius,
} from '../device-pointer-presentation';

describe('AgentInteractionIndicator', () => {
  test('renders the reference pink cursor treatment with one agent name tag', () => {
    const markup = renderToStaticMarkup(<AgentInteractionIndicator />);

    expect(markup.match(/data-agent-cursor=/g)).toHaveLength(2);
    expect(markup.match(/data-agent-cursor-label/g)).toHaveLength(1);
    expect(markup).toContain('background:var(--expo-theme-agent-surface)');
    expect(markup).toContain('border:1px solid var(--expo-theme-agent-border)');
    expect(markup).toContain('background-color:var(--expo-theme-agent-accent)');
    expect(markup).toContain('color:var(--expo-theme-agent-on-accent)');
    expect(markup).toContain('font-size:var(--expo-text-size-xs-font-size)');
    expect(markup).toContain('border-radius:var(--expo-radius-sm) var(--expo-radius-xl)');
    expect(markup).toContain('overflow:visible');
    expect(markup).not.toContain('overflow:hidden');
    expect(markup).toContain('>agent</span>');
    expect(markup).not.toContain('var(--expo-theme-border-info)');
  });

  test('shares token-backed label typography and mirrors the attached corner', () => {
    expect(DEVICE_POINTER_LABEL_STYLE.fontSize).toBe('var(--expo-text-size-xs-font-size)');
    expect(devicePointerLabelRadius({ horizontal: 'right', vertical: 'below' })).toStartWith(
      'var(--expo-radius-sm)',
    );
    expect(devicePointerLabelRadius({ horizontal: 'left', vertical: 'below' })).toBe(
      'var(--expo-radius-xl) var(--expo-radius-sm) var(--expo-radius-xl) var(--expo-radius-xl)',
    );
    expect(devicePointerLabelRadius({ horizontal: 'left', vertical: 'above' })).toBe(
      'var(--expo-radius-xl) var(--expo-radius-xl) var(--expo-radius-sm) var(--expo-radius-xl)',
    );
    expect(devicePointerLabelRadius({ horizontal: 'right', vertical: 'above' })).toEndWith(
      'var(--expo-radius-sm)',
    );
  });
});
