import {
  type DeviceClipboardAction,
  type DeviceClipboardCapabilities,
  type DeviceOrientationUnavailableReason,
} from "@expo/hub-client";
import {
  CONTROL_BUTTON_SIZE,
  CONTROL_ICON_SIZE,
  CameraIcon,
  ClipboardPasteIcon,
  ControlButton,
  CopyIcon,
  Dropdown,
  DropdownItem,
  HomeIcon,
  KeyboardDismissIcon,
  KeyboardIcon,
  ReloadIcon,
  RotateIcon,
  SquareIcon,
  TriangleBackIcon,
  bg,
  border,
  radius,
} from "../primitives";
import { rotationUnavailableText } from "./rotation-availability";

const TOOLBAR_PADDING = 8;
const TOOLBAR_GAP = 4;
/** Stroke of the Hub's own toolbar icons, the weight of the styleguide's outline icons. */
const ICON_STROKE = 2;

/** Rendered height of a one-row toolbar: a button plus the toolbar's padding and hairline border. */
export const STREAM_CONTROLS_HEIGHT = CONTROL_BUTTON_SIZE + TOOLBAR_PADDING * 2 + 2;

/**
 * Controls under the device stream, in the look of the website's device
 * controls: one rounded bar of round icon buttons. Each button shows a tooltip
 * that says what it does.
 *
 * The order follows the website. An Android device leads with its navigation
 * buttons in the order of its navigation bar (Back, Home, Recents), then
 * Dismiss keyboard. Screenshot and Reload follow on both platforms. The
 * controls that only the Hub has come last: the Clipboard menu (Copy, then
 * Paste, as in serve-sim), the Keyboard toggle of a phone layout, and Rotate.
 *
 * The controls do not follow the stream status: input can work while video
 * fails. Only Rotate locks, from the client's `orientationUnavailable`, and its
 * tooltip then gives the reason. "Reload" reloads the running React
 * Native/Expo bundle via the active device client.
 */
// @ref LLP 0013#orientation — Rotate locks from orientationUnavailable only; the toolbar does not check the stream status
export function StreamControls({
  onBack,
  onHome,
  onRecents,
  onDismissKeyboard,
  onReload,
  onRotate,
  onSave,
  saving = false,
  orientationUnavailable,
  clipboard = false,
  clipboardPending = null,
  onPaste,
  onCopy,
  keyboard,
}: {
  /** Press the Android Back button. The control shows only when given. */
  onBack?: () => void;
  /** Press the device Home button. */
  onHome?: () => void;
  /** Press the Android Recents button. The control shows only when given. */
  onRecents?: () => void;
  /** Hide the Android on-screen keyboard. The control shows only when given. */
  onDismissKeyboard?: () => void;
  /** Reload the running React Native/Expo bundle. */
  onReload?: () => void;
  /** Rotate the device. */
  onRotate?: () => void;
  /** Save a screenshot of the device (triggers a file download). */
  onSave?: () => void;
  /** A screenshot is in flight. The Screenshot control shows a spinner. */
  saving?: boolean;
  /** The client's `orientationUnavailable`. Locks Rotate and picks the explanation while set. */
  orientationUnavailable: DeviceOrientationUnavailableReason | null;
  /** The clipboard actions the device offers. Each one shows only when the device has it. */
  clipboard?: DeviceClipboardCapabilities;
  /** A clipboard action is in flight. The Clipboard control shows a spinner. */
  clipboardPending?: DeviceClipboardAction | null;
  /** Paste the browser clipboard into the device app. */
  onPaste?: () => void;
  /** Copy the text selected in the device app to the browser clipboard. */
  onCopy?: () => void;
  /** Type with this device's own keyboard. The control shows only when given. */
  keyboard?: { open: boolean; onToggle: () => void };
}) {
  const rotateUnavailable = rotationUnavailableText(orientationUnavailable);
  const clipboardBusy = clipboardPending !== null;
  const showClipboard = !!clipboard && (clipboard.paste || clipboard.copy);
  const iconSize = CONTROL_ICON_SIZE;

  return (
    <div
      role="toolbar"
      aria-label="Device controls"
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: TOOLBAR_GAP,
        padding: TOOLBAR_PADDING,
        boxSizing: "border-box",
        border: `1px solid ${border.default}`,
        borderRadius: radius["2xl"],
        backgroundColor: bg.element,
      }}
    >
      {onBack && (
        <ControlButton
          label="Go back"
          icon={<TriangleBackIcon size={iconSize} />}
          onClick={onBack}
        />
      )}
      <ControlButton
        label="Go to home screen"
        icon={<HomeIcon size={iconSize} />}
        onClick={onHome}
      />
      {onRecents && (
        <ControlButton
          label="Show recent apps"
          icon={<SquareIcon size={iconSize} />}
          onClick={onRecents}
        />
      )}
      {onDismissKeyboard && (
        <ControlButton
          label="Dismiss keyboard"
          icon={<KeyboardDismissIcon size={iconSize} />}
          onClick={onDismissKeyboard}
        />
      )}
      <ControlButton
        label="Take screenshot"
        icon={<CameraIcon size={iconSize} />}
        loading={saving}
        onClick={onSave}
      />
      <ControlButton label="Reload app" icon={<ReloadIcon size={iconSize} />} onClick={onReload} />
      {showClipboard && (
        <Dropdown
          side="top"
          align="center"
          disabled={clipboardBusy}
          trigger={
            <ControlButton
              label="Clipboard"
              icon={<ClipboardPasteIcon size={iconSize} strokeWidth={ICON_STROKE} />}
              loading={clipboardBusy}
            />
          }
        >
          {clipboard.copy && (
            <DropdownItem
              label="Copy from Simulator"
              Icon={CopyIcon}
              disabled={clipboardBusy}
              onSelect={onCopy}
            />
          )}
          {clipboard.paste && (
            <DropdownItem
              label="Paste from Device"
              Icon={ClipboardPasteIcon}
              disabled={clipboardBusy}
              onSelect={onPaste}
            />
          )}
        </Dropdown>
      )}
      {keyboard && (
        <ControlButton
          label="Keyboard"
          icon={<KeyboardIcon size={iconSize} strokeWidth={ICON_STROKE} />}
          role="switch"
          aria-checked={keyboard.open}
          onClick={keyboard.onToggle}
        />
      )}
      <ControlButton
        label="Rotate device"
        tooltip={rotateUnavailable}
        unavailable={rotateUnavailable !== undefined}
        icon={<RotateIcon size={iconSize} strokeWidth={ICON_STROKE} />}
        onClick={onRotate}
      />
    </div>
  );
}
