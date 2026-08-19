import { type ReactNode } from 'react';

import { Button, radius } from '../primitives';

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
        flexShrink: 0,
        borderRadius: radius.full,
        paddingInline: 14,
        fontWeight: 600,
      }}>
      {children}
    </Button>
  );
}
