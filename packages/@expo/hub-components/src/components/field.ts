import { type CSSProperties } from "react";

import { bg, border, radius, text, textSize } from "../theme/tokens";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";

/** Height of a form control on a sidebar row: the website's `h-9`. */
export const FIELD_HEIGHT = 36;
/** Width of a form control on a sidebar row: the website's `w-32`. Every control in a column has it. */
export const FIELD_WIDTH = 128;
/** Opacity of a field that cannot be used: the website's `opacity-60`. */
export const FIELD_DISABLED_OPACITY = 0.6;

/**
 * The shared look of the sidebar's form controls — select triggers and text
 * fields — in the style of the website's preview options: a 36px box with a
 * hairline border and 8px corners on the default surface. Spread the result
 * onto the element: the class gives it the hover fill and the focus ring.
 */
export function fieldControlProps({
  disabled = false,
  interactive = true,
  width = FIELD_WIDTH,
}: {
  disabled?: boolean;
  /** Whether the fill follows the pointer. A text field keeps one fill. */
  interactive?: boolean;
  /** Width in px. */
  width?: number;
} = {}): { className: string; style: CSSProperties } {
  return {
    className: PRESSABLE_CLASS,
    style: {
      ...textSize.sm,
      ...pressableStyle({
        background: bg.default,
        hoverBackground: interactive && !disabled ? bg.element : bg.default,
        // A field does not scale while pressed.
        pressScale: 1,
      }),
      display: "inline-flex",
      width,
      height: FIELD_HEIGHT,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      boxSizing: "border-box",
      padding: "0 8px",
      border: `1px solid ${border.default}`,
      borderRadius: radius.lg,
      color: text.default,
      fontFamily: "inherit",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? FIELD_DISABLED_OPACITY : 1,
    },
  };
}
