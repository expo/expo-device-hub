import { type ReactNode } from 'react';

import {
  SIDEBAR_TRANSITION_EASING,
  SIDEBAR_TRANSITION_MS,
  useSidebarPresence,
} from './useSidebarPresence';

export function AnimatedDockedSidebar({
  side,
  width,
  open,
  sidebarOpen,
  resizing = false,
  children,
}: {
  side: 'left' | 'right';
  width: number;
  open: boolean;
  /** Whether the sidebar is still open in another layout mode. */
  sidebarOpen: boolean;
  /**
   * Whether the user is dragging the resize handle. The width then follows the
   * pointer directly instead of easing toward each new value.
   */
  resizing?: boolean;
  children: ReactNode;
}) {
  const { present, reducedMotion, visible } = useSidebarPresence(open, !sidebarOpen);
  if (!present) return null;

  const transition =
    reducedMotion || resizing
      ? undefined
      : `width ${SIDEBAR_TRANSITION_MS}ms ${SIDEBAR_TRANSITION_EASING}`;
  const panelTransition = reducedMotion
    ? undefined
    : `transform ${SIDEBAR_TRANSITION_MS}ms ${SIDEBAR_TRANSITION_EASING}`;

  return (
    <div
      aria-hidden={!visible || undefined}
      data-sidebar-docked={side}
      data-state={visible ? 'open' : 'closed'}
      style={{
        width: visible ? width : 0,
        height: '100%',
        flexShrink: 0,
        overflow: 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
        transition,
      }}>
      <div
        style={{
          width,
          height: '100%',
          transform: visible
            ? 'translateX(0)'
            : `translateX(${side === 'left' ? '-100%' : '100%'})`,
          transition: panelTransition,
          willChange: 'transform',
        }}>
        {children}
      </div>
    </div>
  );
}
