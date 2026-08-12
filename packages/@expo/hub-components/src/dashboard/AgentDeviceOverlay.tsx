import { type CSSProperties } from 'react';

import { bg, text, textSize } from '../primitives';

/** Hover-only notice layered over a device while Argent activity is current. */
export function AgentDeviceOverlay({
  visible,
  borderRadius,
}: {
  visible: boolean;
  borderRadius: CSSProperties['borderRadius'];
}) {
  return (
    <div
      hidden={!visible}
      aria-hidden={!visible}
      data-testid="agent-device-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        display: visible ? 'flex' : 'none',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        boxSizing: 'border-box',
        borderRadius,
        backgroundColor: bg.overlay,
        color: text.preview,
        pointerEvents: 'none',
        textAlign: 'center',
        ...textSize.sm,
        fontWeight: 600,
      }}>
      Agent is using this device
    </div>
  );
}
