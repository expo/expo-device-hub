import { type ReactNode } from 'react';

import { PillButton } from '../primitives';

/**
 * The action control on an inspector row (Toggle, Press, Shut down, Remove):
 * a {@link PillButton}, so it matches the select pills on neighbouring rows.
 */
export function SidebarActionButton({
  children,
  disabled = false,
  destructive = false,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  /** Color the label as a destructive action (e.g. removing a device). */
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <PillButton disabled={disabled} destructive={destructive} onClick={onClick}>
      {children}
    </PillButton>
  );
}
