import { bg, text, textSize } from '../primitives';

/** Unshaped hover notice; PhoneFrame clips it to the device screen. */
export function AgentDeviceOverlay({ visible }: { visible: boolean }) {
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
