import { type CSSProperties, useState } from 'react';

import { bg, border, radius, text, textSize } from '../theme/tokens';

/**
 * A circular on/off toggle with an optional caption, styled to match the
 * surrounding control buttons. The whole column (circle + caption) is the hover
 * and click target, so hovering the label highlights the circle too. The inner
 * dot uses `text.default`, reading dark on a light theme and light on a dark one.
 */
export type SwitchProps = {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
};

export function Switch({ checked, onChange, label }: SwitchProps) {
  const [hovered, setHovered] = useState(false);

  const circleStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    boxSizing: 'border-box',
    borderRadius: radius.full,
    border: `1px solid ${border.default}`,
    backgroundColor: hovered ? bg.element : 'transparent',
    transition: 'background-color 150ms ease',
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange?.(!checked)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: 0,
        border: 'none',
        background: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}>
      <span style={circleStyle}>
        <span
          style={{ width: 16, height: 16, borderRadius: radius.full, backgroundColor: text.default }}
        />
      </span>
      {label && (
        <span style={{ ...textSize['2xs'], color: text.secondary, textAlign: 'center' }}>
          {label}
        </span>
      )}
    </button>
  );
}
