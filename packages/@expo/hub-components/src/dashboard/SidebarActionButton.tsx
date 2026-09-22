import { type ReactNode } from 'react';

import { PillButton } from '../primitives';
import { DisabledControlHint } from '../components/DisabledControlHint';

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
}: {
  children: ReactNode;
  disabled?: boolean;
  descriptionId?: string;
  disabledReason?: string;
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <DisabledControlHint
      reason={disabled ? disabledReason : undefined}
      label={typeof children === 'string' ? children : undefined}>
      <PillButton
        disabled={disabled}
        aria-describedby={descriptionId}
        destructive={destructive}
        onClick={onClick}>
        {children}
      </PillButton>
    </DisabledControlHint>
  );
}
