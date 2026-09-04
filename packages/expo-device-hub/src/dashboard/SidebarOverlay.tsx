import { bg, border } from '@expo/hub-components';
import { type ReactNode } from 'react';

import {
  SIDEBAR_TRANSITION_EASING,
  SIDEBAR_TRANSITION_MS,
  useSidebarPresence,
} from './useSidebarPresence';

export function SidebarOverlay({
  side,
  open,
  sidebarOpen,
  topmost,
  onDismiss,
  children,
}: {
  side: 'left' | 'right';
  open: boolean;
  /** Whether the sidebar is still open in another layout mode. */
  sidebarOpen: boolean;
  topmost: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { present, reducedMotion, visible } = useSidebarPresence(open, !sidebarOpen);
  if (!present) return null;

  const backdropZIndex = topmost ? 12 : 10;
  const backdropTransition = reducedMotion
    ? undefined
    : `opacity ${SIDEBAR_TRANSITION_MS}ms ease`;
  const panelTransition = reducedMotion
    ? undefined
    : `transform ${SIDEBAR_TRANSITION_MS}ms ${SIDEBAR_TRANSITION_EASING}`;

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
          opacity: visible ? 0.35 : 0,
          pointerEvents: visible ? undefined : 'none',
          transition: backdropTransition,
          zIndex: backdropZIndex,
        }}
      />
      <div
        aria-hidden={!visible || undefined}
        data-sidebar-overlay={side}
        data-state={visible ? 'open' : 'closed'}
        style={{
          position: 'absolute',
          top: 0,
          [side]: 0,
          zIndex: backdropZIndex + 1,
          backgroundColor: bg.default,
          // The seam toward the content is the same hairline the docked layout uses.
          [side === 'left' ? 'borderRight' : 'borderLeft']: `1px solid ${border.default}`,
          pointerEvents: visible ? undefined : 'none',
          transform: visible
            ? 'translateX(0)'
            : `translateX(${side === 'left' ? '-100%' : '100%'})`,
          transition: panelTransition,
          willChange: 'transform',
        }}>
        {children}
      </div>
    </>
  );
}
