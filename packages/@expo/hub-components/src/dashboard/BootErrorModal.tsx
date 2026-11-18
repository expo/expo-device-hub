import { Button, Modal, bg, border, font, radius, text, textSize, tone } from "../primitives";

/**
 * Error dialog shown when booting a device on the host failed (e.g. the
 * emulator process died before coming adb-online). The `message` is the
 * server's failure reason — typically a one-line summary followed by the
 * emulator's own error output — so it renders as preformatted mono text.
 */
export type BootErrorModalProps = {
  open: boolean;
  onClose: () => void;
  /** Display name of the device that failed to boot. */
  deviceName: string;
  /** Failure reason from the boot request; may span multiple lines. */
  message: string;
};

export function BootErrorModal({ open, onClose, deviceName, message }: BootErrorModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Failed to boot device">
      <p style={{ ...textSize.sm, margin: 0, color: text.secondary }}>
        <strong style={{ color: text.default, fontWeight: 600 }}>{deviceName}</strong> could not be
        booted.
      </p>
      <pre
        style={{
          ...textSize.xs,
          margin: "12px 0 24px",
          padding: "10px 12px",
          overflowX: "auto",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          backgroundColor: bg.subtle,
          border: `1px solid ${border.default}`,
          borderRadius: radius.xl,
          color: tone.danger.text,
          fontFamily: font.mono,
        }}
      >
        {message}
      </pre>
      <Button theme="primary" size="xl" block onClick={onClose}>
        Close
      </Button>
    </Modal>
  );
}
