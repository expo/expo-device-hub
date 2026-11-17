import { type CSSProperties } from "react";

import { bg, border, radius, shadow, text, textSize } from "../theme/tokens";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";

/** Height of a form control on a sidebar row: the website's `h-9`. */
export const FIELD_HEIGHT = 36;
/** Width of a form control on a sidebar row: the website's `w-32`. Every control in a column has it. */
export const FIELD_WIDTH = 128;
/** Opacity of a field that cannot be used: the website's `opacity-60`. */
export const FIELD_DISABLED_OPACITY = 0.6;
/** Height of a form control in a modal, from the dashboard design. */
export const LARGE_FIELD_HEIGHT = 52;

/** `md` is a control on a sidebar row. `lg` is a control of a form in a modal, as wide as the form. */
export type FieldSize = "md" | "lg";

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
  size = "md",
}: {
  disabled?: boolean;
  /** Whether the fill follows the pointer. A text field keeps one fill. */
  interactive?: boolean;
  /** Width in px of an `md` field. An `lg` field fills its form. */
  width?: number;
  size?: FieldSize;
} = {}): { className: string; style: CSSProperties } {
  const large = size === "lg";
  return {
    className: PRESSABLE_CLASS,
    style: {
      ...textSize.sm,
      ...pressableStyle({
        background: bg.default,
        hoverBackground: interactive && !disabled ? bg.element : bg.default,
        // A field does not scale while pressed.
        pressScale: 1,
        shadow: large ? shadow.xs : undefined,
      }),
      display: "inline-flex",
      width: large ? "100%" : width,
      height: large ? LARGE_FIELD_HEIGHT : FIELD_HEIGHT,
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
      boxSizing: "border-box",
      padding: large ? "0 16px" : "0 8px",
      border: `${large ? 0.5 : 1}px solid ${border.default}`,
      borderRadius: large ? radius.xl : radius.lg,
      color: text.default,
      fontFamily: "inherit",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? FIELD_DISABLED_OPACITY : 1,
    },
  };
}
