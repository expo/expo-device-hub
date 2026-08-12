import { Button, bg, text, textSize } from '../primitives';

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
        backgroundColor: `color-mix(in srgb, ${bg.default} 68%, transparent)`,
        backdropFilter: 'blur(18px) saturate(120%)',
        WebkitBackdropFilter: 'blur(18px) saturate(120%)',
        pointerEvents: 'auto',
        textAlign: 'center',
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
        <div style={{ maxWidth: 260, color: text.secondary, ...textSize.sm }}>
          Taking over might collide with what the agent is doing.
        </div>
        <Button theme="secondary" size="lg" onClick={onTakeOver}>
          Take over anyway
        </Button>
      </div>
    </div>
  );
}
