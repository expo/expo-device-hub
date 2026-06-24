import { type CSSProperties, type ReactNode, useState } from 'react';

import { radius, textSize } from '../theme/tokens';

/**
 * Button — ported from the universe website's `ui/components/Button`.
 *
 * The website implementation is Tailwind-class based and depends on Next.js
 * (`next/link`) and `@expo/styleguide` helpers. Expo Hub authors UI as DOM
 * components with inline styles, so this is a self-contained port that drives
 * the same `--expo-theme-button-*` tokens (see `theme/theme.css`). It looks and
 * behaves like the website button (themes, sizes, hover/active/disabled) but has
 * no Tailwind or Next.js dependency.
 *
 * Keep the theme/size matrix in sync with the website if it changes upstream.
 */

export type ButtonTheme =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'quaternary'
  | 'primary-destructive'
  | 'secondary-destructive'
  | 'tertiary-destructive';

export type ButtonSize = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';

type ThemeTokens = {
  background: string;
  hover: string;
  text: string;
  border: string;
  disabledBackground: string;
  disabledBorder: string;
  disabledText: string;
};

// Maps each theme to the matching `--expo-theme-button-*` CSS variables.
const THEME_TOKENS: Record<ButtonTheme, ThemeTokens> = {
  primary: cssTheme('primary'),
  secondary: cssTheme('secondary'),
  tertiary: cssTheme('tertiary'),
  quaternary: cssTheme('quaternary'),
  'primary-destructive': cssTheme('primary-destructive'),
  'secondary-destructive': cssTheme('secondary-destructive'),
  'tertiary-destructive': cssTheme('tertiary-destructive'),
};

function cssTheme(name: string): ThemeTokens {
  const v = (suffix: string) => `var(--expo-theme-button-${name}-${suffix})`;
  return {
    background: v('background'),
    hover: v('hover'),
    text: v('text'),
    border: v('border'),
    disabledBackground: v('disabled-background'),
    disabledBorder: v('disabled-border'),
    disabledText: v('disabled-text'),
  };
}

// Height / horizontal padding / radius / font size per size — mirrors the
// website's getSizeClasses (h-N, px-N, rounded, text-*).
const SIZE_STYLES: Record<ButtonSize, CSSProperties> = {
  '2xs': { height: 28, paddingInline: 8, borderRadius: radius.lg, ...textSize.xs },
  xs: { height: 32, paddingInline: 12, borderRadius: radius.lg, ...textSize.xs },
  sm: { height: 36, paddingInline: 16, borderRadius: radius.lg, ...textSize.sm },
  md: { height: 40, paddingInline: 16, borderRadius: radius.lg, ...textSize.sm },
  lg: { height: 44, paddingInline: 24, borderRadius: radius.lg, ...textSize.base },
  xl: { height: 48, paddingInline: 24, borderRadius: radius.lg, ...textSize.base },
  '2xl': { height: 60, paddingInline: 24, borderRadius: radius.lg, ...textSize.lg },
};

export type ButtonProps = {
  children?: ReactNode;
  theme?: ButtonTheme;
  size?: ButtonSize;
  /** Render a leading icon/element. */
  leftSlot?: ReactNode;
  /** Render a trailing icon/element. */
  rightSlot?: ReactNode;
  /** Stretch to fill the parent width. */
  block?: boolean;
  disabled?: boolean;
  /** Renders an `<a>` instead of a `<button>`. */
  href?: string;
  target?: string;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
};

export function Button({
  children,
  theme = 'primary',
  size = 'sm',
  leftSlot,
  rightSlot,
  block = false,
  disabled = false,
  href,
  target,
  onClick,
  className,
  style,
}: ButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const t = THEME_TOKENS[theme];

  const baseStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: size === '2xs' ? 4 : size === 'xs' ? 6 : 8,
    border: '1px solid',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'default' : 'pointer',
    textDecoration: 'none',
    transition: 'background-color 150ms ease, transform 100ms ease, opacity 150ms ease',
    width: block ? '100%' : undefined,
    transform: !disabled && pressed ? 'scale(0.98)' : undefined,
    ...SIZE_STYLES[size],
    backgroundColor: disabled ? t.disabledBackground : hovered ? t.hover : t.background,
    borderColor: disabled ? t.disabledBorder : t.border,
    color: disabled ? t.disabledText : t.text,
    opacity: disabled ? 0.8 : 1,
    pointerEvents: disabled ? 'none' : undefined,
    ...style,
  };

  const content = (
    <>
      {leftSlot}
      {children != null && <span style={{ display: 'flex', lineHeight: 1 }}>{children}</span>}
      {rightSlot}
    </>
  );

  const handlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => {
      setHovered(false);
      setPressed(false);
    },
    onMouseDown: () => setPressed(true),
    onMouseUp: () => setPressed(false),
  };

  if (href) {
    return (
      <a
        href={disabled ? undefined : href}
        target={target}
        className={className}
        style={baseStyle}
        onClick={disabled ? undefined : onClick}
        {...handlers}>
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={className}
      style={baseStyle}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
      {...handlers}>
      {content}
    </button>
  );
}
