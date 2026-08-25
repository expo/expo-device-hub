import { Button, text, textSize } from '../primitives';

// Match the flat connection-state surface in @expo/hub-client/DeviceScreen.
const DEVICE_STATUS_OVERLAY_BACKGROUND = 'rgba(0, 0, 0, 0.55)';
const DEVICE_STATUS_OVERLAY_TEXT = 'rgba(255, 255, 255, 0.7)';

/** Unshaped hover notice; PhoneFrame clips it to the device screen. */
export function AgentDeviceOverlay({
  visible,
  onTakeOver,
}: {
  visible: boolean;
  onTakeOver: () => void;
}) {
  return (
    <div
      hidden={!visible}
      aria-hidden={!visible}
      role="dialog"
      aria-label="Agent device activity"
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
        pointerEvents: 'auto',
        textAlign: 'center',
        backgroundColor: DEVICE_STATUS_OVERLAY_BACKGROUND,
      }}>
      <div
        style={{
          display: 'flex',
          width: '100%',
          maxWidth: 300,
          flexDirection: 'column',
          alignItems: 'center',
          gap: 16,
        }}>
        <div style={{ color: text.info, ...textSize.base, fontWeight: 600 }}>
          Agent is using this device
        </div>
        <div style={{ maxWidth: 260, color: DEVICE_STATUS_OVERLAY_TEXT, ...textSize.sm }}>
          Taking over might collide with what the agent is doing.
        </div>
        <Button
          theme="agent-overlay"
          size="lg"
          onClick={onTakeOver}
          style={{ fontFamily: 'inherit' }}>
          <span style={{ ...textSize.sm, fontWeight: 500 }}>Take over anyway</span>
        </Button>
      </div>
    </div>
  );
}
