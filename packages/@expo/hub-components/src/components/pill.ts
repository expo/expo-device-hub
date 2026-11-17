import { type CSSProperties } from "react";

import { bg, border, opacity, radius, text, textSize } from "../theme/tokens";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";

export const PILL_CONTROL_HEIGHT = 28;

/**
 * The shared look of the inspector's compact controls — select triggers,
 * action buttons and text fields — so every control on a sidebar row reads as
 * the same pill. Spread the result onto the element: the class gives it the
 * hover fill and the keyboard focus ring.
 */
export function pillControlProps({
  disabled = false,
  pressScale,
}: {
  disabled?: boolean;
  /** Pass 1 for a control that must not scale while pressed, such as a text field. */
  pressScale?: number;
} = {}): { className: string; style: CSSProperties } {
  return {
    className: PRESSABLE_CLASS,
    style: {
      ...textSize.sm,
      ...pressableStyle({ background: bg.element, hoverBackground: bg.hover, pressScale }),
      fontWeight: 500,
      display: "inline-flex",
      height: PILL_CONTROL_HEIGHT,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      boxSizing: "border-box",
      padding: "0 10px",
      border: `1px solid ${border.default}`,
      borderRadius: radius.lg,
      color: text.default,
      fontFamily: "inherit",
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? opacity.disabled : 1,
    },
  };
}
