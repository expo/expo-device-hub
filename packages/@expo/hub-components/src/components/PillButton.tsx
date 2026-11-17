import { type ButtonHTMLAttributes, type Ref } from "react";

import { text } from "../theme/tokens";
import { cx } from "./cx";
import { pillControlProps } from "./pill";

export type PillButtonProps = {
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A compact action button in the inspector's pill style ({@link pillControlProps}),
 * so it reads as the same control as a `Select` trigger on a neighbouring row.
 *
 * `Button` stays the general-purpose primitive; this one exists for the
 * controls that sit next to select pills. Extra props go to the `<button>`.
 */
export function PillButton({
  destructive = false,
  disabled = false,
  className,
  style,
  children,
  ref,
  ...rest
}: PillButtonProps) {
  const pill = pillControlProps({ disabled });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cx(pill.className, className)}
      style={{
        ...pill.style,
        color: destructive ? text.danger : text.default,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
