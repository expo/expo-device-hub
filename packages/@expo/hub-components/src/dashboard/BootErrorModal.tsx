import {
  Button,
  DialogContent,
  DialogContentContainer,
  DialogFooter,
  DialogRoot,
  DialogTitle,
  bg,
  border,
  font,
  radius,
  text,
} from '../primitives';

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
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}>
      <DialogContent>
        <DialogTitle title="Failed to boot device" />
        <DialogContentContainer>
          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: text.secondary }}>
            <strong style={{ color: text.default, fontWeight: 600 }}>{deviceName}</strong> could
            not be booted.
          </p>
          <pre
            style={{
              margin: '6px 0 0',
              padding: '10px 12px',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              backgroundColor: bg.subtle,
              border: `1px solid ${border.default}`,
              borderRadius: radius.lg,
              color: text.danger,
              fontFamily: font.mono,
              fontSize: 12,
              lineHeight: 1.5,
            }}>
            {message}
          </pre>
        </DialogContentContainer>
        <DialogFooter>
          <Button theme="primary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
