import { type ReactNode } from 'react';

import { Button, radius, textSize } from '../primitives';

/** A compact secondary button sized like the inspector's select pills. */
export function SidebarActionButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="2xs"
      theme="secondary"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...textSize.sm,
        flexShrink: 0,
        borderRadius: radius.lg,
        paddingInline: 10,
        fontWeight: 500,
      }}>
      {children}
    </Button>
  );
}
