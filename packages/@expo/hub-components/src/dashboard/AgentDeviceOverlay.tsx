import { forwardRef, useImperativeHandle, useRef } from 'react';

import {
  DEVICE_POINTER_LABEL_OFFSET_X,
  DEVICE_POINTER_LABEL_OFFSET_Y,
  DEVICE_POINTER_LABEL_STYLE,
  DEVICE_POINTER_STYLE,
  devicePointerLabelRadius,
} from '@expo/hub-client';
import { bg, border, radius, shadow, text, textSize } from '../primitives';

export type AgentDeviceOverlayPlacement = {
  horizontal: 'left' | 'right';
  vertical: 'above' | 'below';
};

export type AgentDeviceOverlayPosition = {
  clientX: number;
  clientY: number;
  frameLeft: number;
  frameTop: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type AgentDeviceOverlayHandle = {
  position: (position: AgentDeviceOverlayPosition) => void;
};

const CALLOUT_GAP = 16;
const CALLOUT_MARGIN = 16;
const CALLOUT_WIDTH = 168;
const CALLOUT_HEIGHT = 50;

/** Keep the pointer callout on the side with enough browser viewport space. */
export function agentDeviceOverlayPlacement({
  clientX,
  clientY,
  viewportWidth,
  viewportHeight,
}: {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  viewportHeight: number;
}): AgentDeviceOverlayPlacement {
  return {
    horizontal:
      clientX + CALLOUT_GAP + CALLOUT_WIDTH + CALLOUT_MARGIN <= viewportWidth ? 'right' : 'left',
    vertical:
      clientY + CALLOUT_GAP + CALLOUT_HEIGHT + CALLOUT_MARGIN <= viewportHeight ? 'below' : 'above',
  };
}

/** Non-blocking identity and interruption notice positioned beside the user's pointer. */
export const AgentDeviceOverlay = forwardRef<
  AgentDeviceOverlayHandle,
  { visible: boolean; warningVisible?: boolean }
>(function AgentDeviceOverlay({ visible, warningVisible = true }, ref) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(ref, () => ({
    position({ clientX, clientY, frameLeft, frameTop, viewportWidth, viewportHeight }) {
      const callout = anchorRef.current;
      const stack = stackRef.current;
      const label = labelRef.current;
      if (!callout || !stack || !label) return;

      const placement = agentDeviceOverlayPlacement({
        clientX,
        clientY,
        viewportWidth,
        viewportHeight,
      });
      callout.style.left = `${clientX - frameLeft}px`;
      callout.style.top = `${clientY - frameTop}px`;
      callout.dataset.horizontalPlacement = placement.horizontal;
      callout.dataset.verticalPlacement = placement.vertical;

      stack.style.left =
        placement.horizontal === 'right' ? `${DEVICE_POINTER_LABEL_OFFSET_X}px` : 'auto';
      stack.style.right =
        placement.horizontal === 'left' ? `${DEVICE_POINTER_LABEL_OFFSET_X}px` : 'auto';
      stack.style.top =
        placement.vertical === 'below' ? `${DEVICE_POINTER_LABEL_OFFSET_Y}px` : 'auto';
      stack.style.bottom =
        placement.vertical === 'above' ? `${DEVICE_POINTER_LABEL_OFFSET_Y}px` : 'auto';
      stack.style.alignItems = placement.horizontal === 'right' ? 'flex-start' : 'flex-end';
      stack.style.flexDirection = placement.vertical === 'below' ? 'column' : 'column-reverse';
      label.style.borderRadius = devicePointerLabelRadius(placement);
    },
  }));

  return (
    <div
      hidden={!visible}
      aria-hidden={!visible}
      data-testid="agent-device-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        display: visible ? 'block' : 'none',
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      <div
        ref={anchorRef}
        data-testid="user-pointer-callout"
        style={{
          ...DEVICE_POINTER_STYLE,
          pointerEvents: 'none',
          willChange: 'left, top',
        }}
      >
        <span
          aria-hidden="true"
          data-testid="user-pointer-cursor"
          style={{
            position: 'absolute',
            inset: 0,
            boxSizing: 'border-box',
            border: `1px solid ${border.secondary}`,
            borderRadius: radius.full,
            backgroundColor: bg.overlay,
            boxShadow: shadow.sm,
            opacity: 0.78,
          }}
        />
        <div
          ref={stackRef}
          data-testid="user-pointer-callout-stack"
          style={{
            position: 'absolute',
            left: DEVICE_POINTER_LABEL_OFFSET_X,
            top: DEVICE_POINTER_LABEL_OFFSET_Y,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 6,
          }}
        >
          <span
            ref={labelRef}
            data-testid="user-pointer-label"
            style={{
              ...DEVICE_POINTER_LABEL_STYLE,
              minWidth: 50,
              border: `1px solid ${border.default}`,
              borderRadius: devicePointerLabelRadius({
                horizontal: 'right',
                vertical: 'below',
              }),
              backgroundColor: bg.overlay,
              boxShadow: shadow.sm,
              color: text.default,
              fontWeight: 600,
            }}
          >
            you
          </span>
          {warningVisible && (
            <span
              role="note"
              data-testid="agent-interruption-warning"
              style={{
                display: 'block',
                width: 'max-content',
                maxWidth: `calc(100vw - ${CALLOUT_MARGIN * 2}px)`,
                padding: '6px 8px',
                boxSizing: 'border-box',
                borderRadius: radius.lg,
                backgroundColor: bg.overlay,
                boxShadow: shadow.md,
                color: text.secondary,
                ...textSize['2xs'],
              }}
            >
              <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
                Interacting could interrupt
              </span>
              <span style={{ display: 'block', whiteSpace: 'nowrap' }}>
                the agent's current work.
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
});
