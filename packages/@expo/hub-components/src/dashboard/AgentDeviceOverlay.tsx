import { Button, layer, scrim, textSize } from "../primitives";

// A dim layer over the live device screen, in the `scrim` colors. These are the
// values of the connection overlay that hub-client's DeviceScreen drew before
// LLP 0015; the loading and error states now come from `DeviceScreenStatus`.

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
        position: "absolute",
        inset: 0,
        zIndex: layer.screenOverlay,
        display: visible ? "flex" : "none",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        pointerEvents: "auto",
        textAlign: "center",
        backgroundColor: scrim.background,
      }}
    >
      <div
        style={{
          display: "flex",
          width: "100%",
          maxWidth: 300,
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ color: scrim.agentText, ...textSize.sm, fontWeight: 600 }}>
          Agent is using this device
        </div>
        <div style={{ maxWidth: 260, color: scrim.text, ...textSize.xs }}>
          Taking over might collide with what the agent is doing.
        </div>
        <Button
          theme="agent-overlay"
          size="sm"
          onClick={onTakeOver}
          style={{ fontFamily: "inherit" }}
        >
          <span style={{ ...textSize.xs, fontWeight: 500 }}>Take over anyway</span>
        </Button>
      </div>
    </div>
  );
}
