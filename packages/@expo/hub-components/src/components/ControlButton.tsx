import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

import { bg, radius } from "../theme/tokens";
import { ActivityIndicator } from "./ActivityIndicator";
import { BUTTON_THEME_TOKENS } from "./Button";
import { IconButton } from "./IconButton";
import { Tooltip } from "./Tooltip";

/** Width and height of a toolbar button: the website's `size-9`. */
export const CONTROL_BUTTON_SIZE = 36;
/** Width and height of a toolbar icon: the website's `icon-md`. */
export const CONTROL_ICON_SIZE = 20;

/** Opacity of a toolbar button that cannot be used: the website's `opacity-40`. */
const UNAVAILABLE_OPACITY = 0.4;

export type ControlButtonProps = {
  icon: ReactNode;
  /** The accessible name, and the tooltip unless `tooltip` replaces it. */
  label: string;
  /** Replaces the label in the tooltip and describes the button, such as why it is locked. */
  tooltip?: string;
  /**
   * The action cannot run now. The button dims and ignores clicks, but it keeps
   * its tooltip and its place in the tab order, so the reason stays reachable.
   */
  unavailable?: boolean;
  /** The action runs. A spinner replaces the icon and the button ignores clicks. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A round icon button in the toolbar under the device stream, in the look of
 * the website's device controls: a quaternary button of 36px with a 20px icon.
 * Its tooltip shows above the button while the pointer is over it or it has
 * keyboard focus. Extra props go to the `<button>`, so it also works as a
 * Radix `asChild` trigger.
 */
export function ControlButton({
  icon,
  label,
  tooltip,
  unavailable = false,
  loading = false,
  disabled,
  onClick,
  style,
  ...rest
}: ControlButtonProps) {
  const blocked = unavailable || loading;
  return (
    <Tooltip content={tooltip ?? label}>
      <IconButton
        icon={loading ? <ActivityIndicator size={CONTROL_ICON_SIZE} /> : icon}
        label={label}
        aria-description={tooltip}
        aria-disabled={blocked || undefined}
        aria-busy={loading || undefined}
        disabled={disabled}
        size={CONTROL_BUTTON_SIZE}
        // The website's quaternary hover is the fill of the toolbar itself. The
        // Hub uses the next surface step, so that the hover shows.
        hoverBackground={bg.hover}
        onClick={blocked ? undefined : onClick}
        style={{
          borderRadius: radius.full,
          color: BUTTON_THEME_TOKENS.quaternary.icon,
          cursor: blocked || disabled ? "default" : "pointer",
          // A button that works on its action stays at full opacity, as on the website.
          opacity: !loading && (unavailable || disabled) ? UNAVAILABLE_OPACITY : 1,
          ...style,
        }}
        {...rest}
      />
    </Tooltip>
  );
}
