/**
 * Typed design tokens for Expo Hub.
 *
 * These mirror the semantic tokens from `@expo/styleguide` (the universe
 * website's design system). They resolve to the CSS custom properties defined
 * in `theme/theme.css`, so they automatically follow light/dark mode.
 *
 * Because Expo Hub's UI is authored as DOM components (`'use dom'`) with inline
 * styles instead of Tailwind, use these tokens anywhere you'd otherwise reach
 * for a hard-coded color, font size, radius, or shadow. That keeps Hub visually
 * identical to the website.
 *
 * On the website the equivalent Tailwind class is shown in a comment, e.g.
 * `text.default` ⇄ `text-default`, `bg.subtle` ⇄ `bg-subtle`.
 */

/** Surface / background colors. Tailwind: `bg-*`. */
export const bg = {
  default: 'var(--expo-theme-background-default)',
  screen: 'var(--expo-theme-background-screen)',
  subtle: 'var(--expo-theme-background-subtle)',
  element: 'var(--expo-theme-background-element)',
  hover: 'var(--expo-theme-background-hover)',
  selected: 'var(--expo-theme-background-selected)',
  overlay: 'var(--expo-theme-background-overlay)',
  success: 'var(--expo-theme-background-success)',
  warning: 'var(--expo-theme-background-warning)',
  danger: 'var(--expo-theme-background-danger)',
  info: 'var(--expo-theme-background-info)',
  preview: 'var(--expo-theme-background-preview)',
} as const;

/** Text colors. Tailwind: `text-*`. */
export const text = {
  default: 'var(--expo-theme-text-default)',
  secondary: 'var(--expo-theme-text-secondary)',
  tertiary: 'var(--expo-theme-text-tertiary)',
  quaternary: 'var(--expo-theme-text-quaternary)',
  link: 'var(--expo-theme-text-link)',
  success: 'var(--expo-theme-text-success)',
  warning: 'var(--expo-theme-text-warning)',
  danger: 'var(--expo-theme-text-danger)',
  info: 'var(--expo-theme-text-info)',
  preview: 'var(--expo-theme-text-preview)',
} as const;

/** Icon colors. Tailwind: `text-icon-*`. */
export const icon = {
  default: 'var(--expo-theme-icon-default)',
  secondary: 'var(--expo-theme-icon-secondary)',
  tertiary: 'var(--expo-theme-icon-tertiary)',
  quaternary: 'var(--expo-theme-icon-quaternary)',
  success: 'var(--expo-theme-icon-success)',
  warning: 'var(--expo-theme-icon-warning)',
  danger: 'var(--expo-theme-icon-danger)',
  info: 'var(--expo-theme-icon-info)',
  preview: 'var(--expo-theme-icon-preview)',
} as const;

/** Border colors. Tailwind: `border-*`. */
export const border = {
  default: 'var(--expo-theme-border-default)',
  secondary: 'var(--expo-theme-border-secondary)',
  success: 'var(--expo-theme-border-success)',
  warning: 'var(--expo-theme-border-warning)',
  danger: 'var(--expo-theme-border-danger)',
  info: 'var(--expo-theme-border-info)',
  preview: 'var(--expo-theme-border-preview)',
} as const;

/** Border radii. Tailwind: `rounded-*`. */
export const radius = {
  none: '0',
  xs: 'var(--expo-radius-xs)',
  sm: 'var(--expo-radius-sm)',
  md: 'var(--expo-radius-md)',
  lg: 'var(--expo-radius-lg)',
  xl: 'var(--expo-radius-xl)',
  '2xl': 'var(--expo-radius-2xl)',
  '3xl': 'var(--expo-radius-3xl)',
  full: 'var(--expo-radius-full)',
} as const;

/** Box shadows. Tailwind: `shadow-*`. */
export const shadow = {
  none: 'var(--expo-theme-shadows-none)',
  xs: 'var(--expo-theme-shadows-xs)',
  sm: 'var(--expo-theme-shadows-sm)',
  md: 'var(--expo-theme-shadows-md)',
  lg: 'var(--expo-theme-shadows-lg)',
  xl: 'var(--expo-theme-shadows-xl)',
} as const;

/** Font families. Tailwind: `font-sans` / `font-mono` (set globally). */
export const font = {
  sans: 'var(--expo-font-sans)',
  mono: 'var(--expo-font-mono)',
} as const;

type TextStyle = {
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  letterSpacing: string;
};

/**
 * Body text scale. Tailwind: `text-2xl` … `text-2xs`.
 * Spread onto an element's `style`, e.g. `style={{ ...textSize.sm }}`.
 */
export const textSize: Record<'2xl' | 'xl' | 'lg' | 'base' | 'sm' | 'xs' | '2xs', TextStyle> = {
  '2xl': { fontSize: 24, fontWeight: 500, lineHeight: 1.2, letterSpacing: '-0.5px' },
  xl: { fontSize: 20, fontWeight: 500, lineHeight: 1.2, letterSpacing: '-0.25px' },
  lg: { fontSize: 18, fontWeight: 400, lineHeight: 1.4, letterSpacing: '0' },
  base: { fontSize: 16, fontWeight: 400, lineHeight: 1.6, letterSpacing: '0' },
  sm: { fontSize: 14, fontWeight: 400, lineHeight: 1.6, letterSpacing: '0' },
  xs: { fontSize: 12, fontWeight: 400, lineHeight: 1.6, letterSpacing: '0' },
  '2xs': { fontSize: 10, fontWeight: 500, lineHeight: 1.6, letterSpacing: '0' },
};

/**
 * Heading scale. Tailwind: `heading-5xl` … `heading-xs`.
 * Spread onto a heading's `style`, e.g. `style={{ ...heading['2xl'] }}`.
 */
export const heading: Record<
  '5xl' | '4xl' | '3xl' | '2xl' | 'xl' | 'lg' | 'base' | 'sm' | 'xs',
  TextStyle
> = {
  '5xl': { fontSize: 64, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-3px' },
  '4xl': { fontSize: 48, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-2px' },
  '3xl': { fontSize: 32, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.5px' },
  '2xl': { fontSize: 24, fontWeight: 600, lineHeight: 1.2, letterSpacing: '-0.5px' },
  xl: { fontSize: 20, fontWeight: 600, lineHeight: 1.4, letterSpacing: '-0.25px' },
  lg: { fontSize: 18, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0' },
  base: { fontSize: 16, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0' },
  sm: { fontSize: 14, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0' },
  xs: { fontSize: 12, fontWeight: 600, lineHeight: 1.6, letterSpacing: '0' },
};

export const tokens = {
  bg,
  text,
  icon,
  border,
  radius,
  shadow,
  font,
  textSize,
  heading,
} as const;
