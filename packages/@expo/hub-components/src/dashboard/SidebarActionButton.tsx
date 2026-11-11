import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { PillButton } from "../primitives";
import { DisabledControlHint } from "../components/DisabledControlHint";

/**
 * The action control on an inspector row (Toggle, Press, Shut down, Remove):
 * a {@link PillButton}, so it matches the select pills on neighbouring rows.
 */
export function SidebarActionButton({
  children,
  disabled = false,
  destructive = false,
  descriptionId,
  disabledReason,
  onClick,
  onPressStart,
  onPressEnd,
}: {
  children: ReactNode;
  disabled?: boolean;
  descriptionId?: string;
  disabledReason?: string;
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  onClick?: () => void;
  /**
   * A hold action: called when the pointer or Enter or Space goes down on the button. Pair it
   * with {@link onPressEnd}.
   */
  onPressStart?: () => void;
  /** Called once when that press ends: on release, cancel, blur, or unmount. */
  onPressEnd?: () => void;
}) {
  const press = useHoldPress(onPressStart, onPressEnd);
  return (
    <DisabledControlHint
      reason={disabled ? disabledReason : undefined}
      label={typeof children === "string" ? children : undefined}
    >
      <PillButton
        disabled={disabled}
        aria-describedby={descriptionId}
        destructive={destructive}
        onClick={onClick}
        {...(onPressStart ? press : {})}
      >
        {children}
      </PillButton>
    </DisabledControlHint>
  );
}

/**
 * Pointer and keyboard handlers for a button that acts while it is held. A press starts on a
 * primary pointer down or on Enter or Space, and ends once, on release, cancel, lost capture,
 * blur, or unmount.
 */
function useHoldPress(onPressStart?: () => void, onPressEnd?: () => void) {
  const pressed = useRef(false);
  const end = useRef(onPressEnd);
  end.current = onPressEnd;
  const start = () => {
    if (pressed.current) return;
    pressed.current = true;
    onPressStart?.();
  };
  const finish = () => {
    if (!pressed.current) return;
    pressed.current = false;
    end.current?.();
  };
  useEffect(() => () => finish(), []);
  return {
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      start();
      // Capture keeps the release on this button when the pointer leaves it while held.
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {}
    },
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onBlur: finish,
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
      start();
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter" || event.key === " ") finish();
    },
  };
}
