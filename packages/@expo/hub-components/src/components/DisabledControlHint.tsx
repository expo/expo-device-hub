import { type ReactNode } from "react";

import { radius } from "../theme/tokens";
import { PRESSABLE_CLASS } from "./pressable";
import { Tooltip } from "./Tooltip";

/** Keeps a disabled control's explanation reachable by pointer and keyboard. */
export function DisabledControlHint({
  reason,
  label,
  children,
}: {
  reason?: string;
  label?: string;
  children: ReactNode;
}) {
  if (!reason) return children;

  return (
    <Tooltip content={reason} align="end" sideOffset={6} delayMs={200}>
      <span
        tabIndex={0}
        role="group"
        aria-label={label}
        aria-description={reason}
        aria-disabled
        // The class gives the wrapper the keyboard focus ring. `aria-disabled` keeps it still.
        className={PRESSABLE_CLASS}
        style={{
          display: "inline-flex",
          maxWidth: "100%",
          borderRadius: radius.lg,
          cursor: "not-allowed",
        }}
      >
        <span style={{ display: "inline-flex", maxWidth: "100%", pointerEvents: "none" }}>
          {children}
        </span>
      </span>
    </Tooltip>
  );
}
