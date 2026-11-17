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
  default: "var(--expo-theme-background-default)",
  screen: "var(--expo-theme-background-screen)",
  subtle: "var(--expo-theme-background-subtle)",
  element: "var(--expo-theme-background-element)",
  hover: "var(--expo-theme-background-hover)",
  selected: "var(--expo-theme-background-selected)",
  overlay: "var(--expo-theme-background-overlay)",
  success: "var(--expo-theme-background-success)",
  warning: "var(--expo-theme-background-warning)",
  danger: "var(--expo-theme-background-danger)",
  info: "var(--expo-theme-background-info)",
  preview: "var(--expo-theme-background-preview)",
} as const;

/** Text colors. Tailwind: `text-*`. */
export const text = {
  default: "var(--expo-theme-text-default)",
  secondary: "var(--expo-theme-text-secondary)",
  tertiary: "var(--expo-theme-text-tertiary)",
  quaternary: "var(--expo-theme-text-quaternary)",
  link: "var(--expo-theme-text-link)",
  success: "var(--expo-theme-text-success)",
  warning: "var(--expo-theme-text-warning)",
  danger: "var(--expo-theme-text-danger)",
  info: "var(--expo-theme-text-info)",
  preview: "var(--expo-theme-text-preview)",
} as const;

/** Icon colors. Tailwind: `text-icon-*`. */
export const icon = {
  default: "var(--expo-theme-icon-default)",
  secondary: "var(--expo-theme-icon-secondary)",
  tertiary: "var(--expo-theme-icon-tertiary)",
  quaternary: "var(--expo-theme-icon-quaternary)",
  success: "var(--expo-theme-icon-success)",
  warning: "var(--expo-theme-icon-warning)",
  danger: "var(--expo-theme-icon-danger)",
  info: "var(--expo-theme-icon-info)",
  preview: "var(--expo-theme-icon-preview)",
} as const;

/** Border colors. Tailwind: `border-*`. */
export const border = {
  default: "var(--expo-theme-border-default)",
  secondary: "var(--expo-theme-border-secondary)",
  success: "var(--expo-theme-border-success)",
  warning: "var(--expo-theme-border-warning)",
  danger: "var(--expo-theme-border-danger)",
  info: "var(--expo-theme-border-info)",
  preview: "var(--expo-theme-border-preview)",
} as const;

/** Border radii. Tailwind: `rounded-*`. */
export const radius = {
  none: "0",
  xs: "var(--expo-radius-xs)",
  sm: "var(--expo-radius-sm)",
  md: "var(--expo-radius-md)",
  lg: "var(--expo-radius-lg)",
  xl: "var(--expo-radius-xl)",
  "2xl": "var(--expo-radius-2xl)",
  "3xl": "var(--expo-radius-3xl)",
  full: "var(--expo-radius-full)",
} as const;

/** Box shadows. Tailwind: `shadow-*`. */
export const shadow = {
  none: "var(--expo-theme-shadows-none)",
  xs: "var(--expo-theme-shadows-xs)",
  sm: "var(--expo-theme-shadows-sm)",
  md: "var(--expo-theme-shadows-md)",
  lg: "var(--expo-theme-shadows-lg)",
  xl: "var(--expo-theme-shadows-xl)",
} as const;

/** Font families. Tailwind: `font-sans` / `font-mono` (set globally). */
export const font = {
  sans: "var(--expo-font-sans)",
  mono: "var(--expo-font-mono)",
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
export const textSize: Record<"2xl" | "xl" | "lg" | "base" | "sm" | "xs" | "2xs", TextStyle> = {
  "2xl": { fontSize: 24, fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.5px" },
  xl: { fontSize: 20, fontWeight: 500, lineHeight: 1.2, letterSpacing: "-0.25px" },
  lg: { fontSize: 18, fontWeight: 400, lineHeight: 1.4, letterSpacing: "0" },
  base: { fontSize: 16, fontWeight: 400, lineHeight: 1.6, letterSpacing: "0" },
  sm: { fontSize: 14, fontWeight: 400, lineHeight: 1.6, letterSpacing: "0" },
  xs: { fontSize: 12, fontWeight: 400, lineHeight: 1.6, letterSpacing: "0" },
  "2xs": { fontSize: 10, fontWeight: 500, lineHeight: 1.6, letterSpacing: "0" },
};

/**
 * Heading scale. Tailwind: `heading-5xl` … `heading-xs`.
 * Spread onto a heading's `style`, e.g. `style={{ ...heading['2xl'] }}`.
 */
export const heading: Record<
  "5xl" | "4xl" | "3xl" | "2xl" | "xl" | "lg" | "base" | "sm" | "xs",
  TextStyle
> = {
  "5xl": { fontSize: 64, fontWeight: 600, lineHeight: 1.1, letterSpacing: "-3px" },
  "4xl": { fontSize: 48, fontWeight: 600, lineHeight: 1.1, letterSpacing: "-2px" },
  "3xl": { fontSize: 32, fontWeight: 600, lineHeight: 1.1, letterSpacing: "-0.5px" },
  "2xl": { fontSize: 24, fontWeight: 600, lineHeight: 1.2, letterSpacing: "-0.5px" },
  xl: { fontSize: 20, fontWeight: 600, lineHeight: 1.4, letterSpacing: "-0.25px" },
  lg: { fontSize: 18, fontWeight: 600, lineHeight: 1.4, letterSpacing: "0" },
  base: { fontSize: 16, fontWeight: 600, lineHeight: 1.4, letterSpacing: "0" },
  sm: { fontSize: 14, fontWeight: 600, lineHeight: 1.4, letterSpacing: "0" },
  xs: { fontSize: 12, fontWeight: 600, lineHeight: 1.6, letterSpacing: "0" },
};

/**
 * Status color sets. A status picks one tone, and every part of its UI (text,
 * icon, border, surface) reads the color from that tone. Change a status color
 * here, not in a component.
 */
export const tone = {
  success: { text: text.success, icon: icon.success, border: border.success, bg: bg.success },
  warning: { text: text.warning, icon: icon.warning, border: border.warning, bg: bg.warning },
  danger: { text: text.danger, icon: icon.danger, border: border.danger, bg: bg.danger },
  info: { text: text.info, icon: icon.info, border: border.info, bg: bg.info },
} as const;

export type Tone = keyof typeof tone;

/**
 * Durations and easings. The `.hub-pressable` rules in `theme.css` read `press`
 * and `base` from the `--hub-motion-*` custom properties; keep both in step.
 */
export const motion = {
  /** A press: the scale of a control under the pointer. */
  press: "100ms",
  /** A small state change: a tooltip, a chevron, a hover fill in a toast. */
  fast: "120ms",
  /** The default state change: hover fills and border colors. */
  base: "150ms",
  /** A panel that opens or closes: a sidebar section. */
  panel: "200ms",
  /** A device frame that changes its shape: a fold or a rotation. */
  frame: "250ms",
  ease: "ease",
  /** Fast start, soft landing: content that enters or opens. */
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** The standard curve for a value that moves between two states. */
  easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

/** The selected item of a list: the info surface with its border, as in the dashboard design. */
export const selection = {
  bg: bg.info,
  border: border.info,
} as const;

/**
 * Colors of a control that is on. The semantic layer has no name for them; the
 * website's `Switch` and slider use these palette steps.
 */
export const accent = {
  /** The track of a switch that is on: `palette-blue10`. */
  default: "var(--blue-10)",
  /** The thumb of a slider: `palette-blue9`. */
  thumb: "var(--blue-9)",
  /** The knob of a switch and the ring of a slider thumb: `palette-white`. */
  knob: "var(--expo-color-white)",
} as const;

/** Opacity of a state, not of a color. */
export const opacity = {
  /** A control that cannot be used. */
  disabled: 0.5,
  /** A value that is out of date. */
  stale: 0.55,
} as const;

/**
 * Stacking order, lowest first. A layer inside the device frame or the stream
 * panel stacks only against its siblings there; the page layers stack against
 * each other.
 */
export const layer = {
  /** Inside the device frame: the loading and error layer over the stream. */
  screenStatus: 1,
  /** Inside the device frame: the agent takeover prompt. */
  screenOverlay: 2,
  /** Inside the stream panel: the corner button of a phone layout. */
  cornerButton: 3,
  /** The sidebar resize handle. Above the stream, below the sidebar overlays. */
  resizeHandle: 5,
  /** The backdrop of a sidebar overlay. Its panel is one above. */
  sidebarBackdrop: 10,
  /** The backdrop of the topmost sidebar overlay. Its panel is one above. */
  sidebarBackdropTopmost: 12,
  /** The floating toggle of a closed sidebar. */
  floatingToggle: 15,
  /** The stream panel in a phone's full-screen presentation. */
  presentation: 20,
  /** Dialog backdrop. The same number as the `z-dialogOverlay-600` class. */
  dialogOverlay: 600,
  /** Dialog content. The same number as the `z-dialogContent-601` class. */
  dialogContent: 601,
  /** Menus and select lists, which can open from a dialog. */
  popover: 605,
  /** Tooltips and the server connection overlay, above every portal. */
  top: 610,
} as const;

/** Colors of a dim layer over live device content. They do not follow the theme. */
export const scrim = {
  /** The dim layer itself. */
  background: "rgba(0, 0, 0, 0.55)",
  /** Secondary text on the dim layer. */
  text: "rgba(255, 255, 255, 0.7)",
  /** Agent-colored text on the dim layer. */
  agentText: "rgba(218, 233, 255, 0.74)",
} as const;

/** One line of text that ends in an ellipsis. The element needs `minWidth: 0` in a flex row. */
export const truncate = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

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
  tone,
  selection,
  accent,
  motion,
  opacity,
  layer,
  scrim,
} as const;
