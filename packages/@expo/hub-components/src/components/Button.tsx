import { type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type Ref } from "react";

import { radius, textSize } from "../theme/tokens";
import { cx } from "./cx";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";

/**
 * Button — ported from the universe website's `ui/components/Button`.
 *
 * The website implementation is Tailwind-class based and depends on Next.js
 * (`next/link`) and `@expo/styleguide` helpers. Expo Hub authors UI as DOM
 * components with inline styles, so this is a self-contained port that drives
 * the same `--expo-theme-button-*` tokens (see `theme/theme.css`). It looks and
 * behaves like the website button (themes, sizes, hover/active/disabled) but has
 * no Tailwind or Next.js dependency. The `.hub-pressable` rules give it the
 * hover fill, the press scale and the keyboard focus ring.
 *
 * Keep the theme/size matrix in sync with the website if it changes upstream.
 */

export type ButtonTheme =
  | "primary"
  | "secondary"
  | "tertiary"
  | "quaternary"
  | "primary-destructive"
  | "secondary-destructive"
  | "tertiary-destructive"
  | "agent-overlay";

export type ButtonSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl";

type ThemeTokens = {
  background: string;
  hover: string;
  text: string;
  /** Color of an icon in the button. The styleguide defines it for its own themes. */
  icon: string;
  border: string;
  disabledBackground: string;
  disabledBorder: string;
  disabledText: string;
};

/** Maps each theme to the matching `--expo-theme-button-*` CSS variables. */
export const BUTTON_THEME_TOKENS: Record<ButtonTheme, ThemeTokens> = {
  primary: cssTheme("primary"),
  secondary: cssTheme("secondary"),
  tertiary: cssTheme("tertiary"),
  quaternary: cssTheme("quaternary"),
  "primary-destructive": cssTheme("primary-destructive"),
  "secondary-destructive": cssTheme("secondary-destructive"),
  "tertiary-destructive": cssTheme("tertiary-destructive"),
  "agent-overlay": cssTheme("agent-overlay"),
};

function cssTheme(name: string): ThemeTokens {
  const v = (suffix: string) => `var(--expo-theme-button-${name}-${suffix})`;
  return {
    background: v("background"),
    hover: v("hover"),
    text: v("text"),
    icon: v("icon"),
    border: v("border"),
    disabledBackground: v("disabled-background"),
    disabledBorder: v("disabled-border"),
    disabledText: v("disabled-text"),
  };
}

/** Rendered height in px of each size — the website's `h-N` classes. */
export const BUTTON_HEIGHTS: Record<ButtonSize, number> = {
  "2xs": 28,
  xs: 32,
  sm: 36,
  md: 40,
  lg: 44,
  xl: 48,
  "2xl": 60,
};

// Height / horizontal padding / radius / font size per size — mirrors the
// website's getSizeClasses (h-N, px-N, rounded, text-*). The website rounds a
// button by its own height, so every size is a pill.
const SIZE_STYLES: Record<ButtonSize, CSSProperties> = {
  "2xs": {
    height: BUTTON_HEIGHTS["2xs"],
    paddingInline: 8,
    borderRadius: radius.full,
    ...textSize.xs,
  },
  xs: { height: BUTTON_HEIGHTS.xs, paddingInline: 12, borderRadius: radius.full, ...textSize.xs },
  sm: { height: BUTTON_HEIGHTS.sm, paddingInline: 16, borderRadius: radius.full, ...textSize.sm },
  md: { height: BUTTON_HEIGHTS.md, paddingInline: 16, borderRadius: radius.full, ...textSize.sm },
  lg: { height: BUTTON_HEIGHTS.lg, paddingInline: 24, borderRadius: radius.full, ...textSize.base },
  xl: { height: BUTTON_HEIGHTS.xl, paddingInline: 24, borderRadius: radius.full, ...textSize.base },
  "2xl": {
    height: BUTTON_HEIGHTS["2xl"],
    paddingInline: 24,
    borderRadius: radius.full,
    ...textSize.lg,
  },
};

type OwnButtonProps = {
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
  /** Native button behavior. Ignored when rendering a link. */
  type?: "button" | "submit" | "reset";
  /** Renders an `<a>` instead of a `<button>`. */
  href?: string;
  target?: string;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  /** The rendered `<button>`. Ignored when rendering a link. */
  ref?: Ref<HTMLButtonElement>;
};

/**
 * Other `<button>` attributes, such as `aria-*` and `id`, pass through to the
 * button, so a Radix trigger can wrap it with `asChild`. Ignored when rendering a link.
 */
export type ButtonProps = OwnButtonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof OwnButtonProps | "color">;

export function Button({
  children,
  theme = "primary",
  size = "sm",
  leftSlot,
  rightSlot,
  block = false,
  disabled = false,
  type = "button",
  href,
  target,
  onClick,
  className,
  style,
  ref,
  ...buttonAttributes
}: ButtonProps) {
  const t = BUTTON_THEME_TOKENS[theme];

  const baseStyle: CSSProperties = {
    ...pressableStyle({
      background: disabled ? t.disabledBackground : t.background,
      hoverBackground: disabled ? t.disabledBackground : t.hover,
    }),
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: size === "2xs" ? 4 : size === "xs" ? 6 : 8,
    border: "1px solid",
    whiteSpace: "nowrap",
    cursor: disabled ? "default" : "pointer",
    textDecoration: "none",
    width: block ? "100%" : undefined,
    ...SIZE_STYLES[size],
    // After the size's text style, whose weight is the body weight: a button label is medium.
    fontWeight: 500,
    borderColor: disabled ? t.disabledBorder : t.border,
    color: disabled ? t.disabledText : t.text,
    opacity: disabled ? 0.8 : 1,
    pointerEvents: disabled ? "none" : undefined,
    ...style,
  };
  const pressableClassName = cx(PRESSABLE_CLASS, className);
  const aria = {
    id: buttonAttributes.id,
    title: buttonAttributes.title,
    "aria-label": buttonAttributes["aria-label"],
    "aria-describedby": buttonAttributes["aria-describedby"],
    "aria-pressed": buttonAttributes["aria-pressed"],
    "aria-expanded": buttonAttributes["aria-expanded"],
  };

  const content = (
    <>
      {leftSlot}
      {children != null && <span style={{ display: "flex", lineHeight: 1 }}>{children}</span>}
      {rightSlot}
    </>
  );

  if (href) {
    return (
      <a
        href={disabled ? undefined : href}
        target={target}
        aria-disabled={disabled || undefined}
        className={pressableClassName}
        style={baseStyle}
        onClick={disabled ? undefined : onClick}
        {...aria}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      {...buttonAttributes}
      ref={ref}
      type={type}
      className={pressableClassName}
      style={baseStyle}
      disabled={disabled}
      onClick={disabled ? undefined : onClick}
    >
      {content}
    </button>
  );
}
