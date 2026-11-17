import { type ReactNode } from "react";

import { Button, DisabledControlHint } from "../primitives";

/**
 * The action control on an inspector row (Toggle, Press, Shut down, Remove): a
 * small secondary {@link Button}, as the website uses beside its options.
 */
export function SidebarActionButton({
  children,
  disabled = false,
  destructive = false,
  descriptionId,
  disabledReason,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  descriptionId?: string;
  disabledReason?: string;
  /** Color the button as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <DisabledControlHint
      reason={disabled ? disabledReason : undefined}
      label={typeof children === "string" ? children : undefined}
    >
      <Button
        theme={destructive ? "secondary-destructive" : "secondary"}
        size="xs"
        disabled={disabled}
        aria-describedby={descriptionId}
        onClick={onClick}
        style={{ flexShrink: 0 }}
      >
        {children}
      </Button>
    </DisabledControlHint>
  );
}
