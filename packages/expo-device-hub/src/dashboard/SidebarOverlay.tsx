import { bg, shadow } from '@expo/hub-components';
import { type ReactNode } from 'react';

export function SidebarOverlay({
  side,
  topmost,
  onDismiss,
  children,
}: {
  side: 'left' | 'right';
  topmost: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const backdropZIndex = topmost ? 12 : 10;

  return (
    <>
      <div
        aria-hidden="true"
        data-sidebar-backdrop={side}
        onClick={onDismiss}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: bg.overlay,
          opacity: 0.35,
          zIndex: backdropZIndex,
        }}
      />
      <div
        data-sidebar-overlay={side}
        style={{
          position: 'absolute',
          top: 0,
          [side]: 0,
          zIndex: backdropZIndex + 1,
          backgroundColor: bg.subtle,
          boxShadow: shadow.lg,
        }}>
        {children}
      </div>
    </>
  );
}
