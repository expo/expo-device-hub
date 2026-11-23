import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

import { bg, border, icon as iconColor, radius } from "../theme/tokens";
import { cx } from "./cx";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";

export type IconButtonProps = {
  icon: ReactNode;
  /** The accessible name. An icon button has no visible text. */
  label: string;
  /** Width and height in px. */
  size?: number;
  /**
   * `ghost` has no border and no fill until the pointer is over it. `outline`
   * is a circle with a hairline border on the default surface. `filled` is a
   * circle on the element surface.
   */
  variant?: "ghost" | "outline" | "filled";
  /** Fill under the pointer. Defaults to the fill of the variant. */
  hoverBackground?: string;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A square button that shows only an icon: the sidebar toggle, a dialog's
 * close button, the add-device button, a corner button on the canvas. Extra
 * props go to the `<button>`, so it also works as a Radix `asChild` trigger.
 */
export function IconButton({
  icon,
  label,
  size = 40,
  variant = "ghost",
  hoverBackground,
  style,
  className,
  ref,
  ...rest
}: IconButtonProps) {
  const outline = variant === "outline";
  const filled = variant === "filled";
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      className={cx(PRESSABLE_CLASS, className)}
      style={{
        ...pressableStyle({
          background: outline ? bg.default : filled ? bg.element : undefined,
          hoverBackground: hoverBackground ?? (outline || filled ? bg.hover : bg.element),
        }),
        display: "flex",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        padding: 0,
        boxSizing: "border-box",
        border: outline ? `1px solid ${border.default}` : "none",
        borderRadius: outline || filled ? radius.full : size >= 40 ? radius.lg : radius.md,
        color: iconColor.default,
        cursor: "pointer",
        fontFamily: "inherit",
        ...style,
      }}
      {...rest}
    >
      {icon}
    </button>
  );
}
