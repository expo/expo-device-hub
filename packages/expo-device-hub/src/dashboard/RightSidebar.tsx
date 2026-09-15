import { bg, border } from '@expo/hub-components';
import { Activity, type ReactNode } from 'react';

import {
  SIDEBAR_TRANSITION_EASING,
  SIDEBAR_TRANSITION_MS,
  useSidebarPresence,
} from './useSidebarPresence';

/** One inspector tree across closing, reopening, and docked/overlay layout changes. */
export function RightSidebar({
  open,
  overlay,
  width,
  resizing,
  topmost,
  onDismiss,
  children,
}: {
  open: boolean;
  /** Whether the available space requires an overlay, even while closed. */
  overlay: boolean;
  width: number;
  resizing: boolean;
  topmost: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { present, reducedMotion, visible } = useSidebarPresence(open, true);
  const backdropZIndex = topmost ? 12 : 10;
  const panelTransition = reducedMotion
    ? undefined
    : `transform ${SIDEBAR_TRANSITION_MS}ms ${SIDEBAR_TRANSITION_EASING}`;

  return (
    <>
      {overlay && present && (
        <div
          aria-hidden="true"
          data-sidebar-backdrop="right"
          onClick={onDismiss}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: bg.overlay,
            opacity: visible ? 0.35 : 0,
            pointerEvents: visible ? undefined : 'none',
            transition: reducedMotion ? undefined : `opacity ${SIDEBAR_TRANSITION_MS}ms ease`,
            zIndex: backdropZIndex,
          }}
        />
      )}
      <div
        aria-hidden={!visible || undefined}
        inert={!visible || undefined}
        data-sidebar-docked={overlay ? undefined : 'right'}
        data-sidebar-overlay={overlay ? 'right' : undefined}
        data-state={visible ? 'open' : 'closed'}
        style={{
          position: overlay ? 'absolute' : undefined,
          top: overlay ? 0 : undefined,
          right: overlay ? 0 : undefined,
          zIndex: overlay ? backdropZIndex + 1 : undefined,
          width: overlay ? `min(${width}px, 100vw)` : visible ? width : 0,
          height: '100%',
          flexShrink: 0,
          overflow: 'hidden',
          pointerEvents: visible ? undefined : 'none',
          transition:
            overlay || reducedMotion || resizing
              ? undefined
              : `width ${SIDEBAR_TRANSITION_MS}ms ${SIDEBAR_TRANSITION_EASING}`,
        }}>
        <div
          style={{
            width: `min(${width}px, 100vw)`,
            height: '100%',
            backgroundColor: bg.default,
            borderLeft: overlay ? `1px solid ${border.default}` : undefined,
            transform: visible ? 'translateX(0)' : 'translateX(100%)',
            transition: panelTransition,
            willChange: 'transform',
          }}>
          {/* Preserve section state and DOM scroll offsets, but release subscriptions
              after the exit animation while the inspector is hidden. */}
          <Activity mode={present ? 'visible' : 'hidden'}>{children}</Activity>
        </div>
      </div>
    </>
  );
}
