import { type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";

import { bg, radius } from "../theme/tokens";
import { IconButton } from "./IconButton";
import { Tooltip } from "./Tooltip";

export const CONTROL_BUTTON_SIZE = 44;

export type ControlButtonProps = {
  icon: ReactNode;
  /** The accessible name, and the tooltip unless `tooltip` replaces it. */
  label: string;
  /** Replaces the label in the tooltip and describes the button, such as why it is locked. */
  tooltip?: string;
  ref?: Ref<HTMLButtonElement>;
} & ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * An icon button in the toolbar under the device stream. Its tooltip shows
 * above the button while the pointer is over it or it has keyboard focus.
 * Extra props go to the `<button>`, so it also works as a Radix `asChild`
 * trigger.
 */
export function ControlButton({ icon, label, tooltip, style, ...rest }: ControlButtonProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <IconButton
        icon={icon}
        label={label}
        aria-description={tooltip}
        size={CONTROL_BUTTON_SIZE}
        hoverBackground={bg.hover}
        style={{
          // Concentric with the surrounding group (radius.xl minus its padding).
          borderRadius: `calc(${radius.xl} - 4px)`,
          ...style,
        }}
        {...rest}
      />
    </Tooltip>
  );
}
