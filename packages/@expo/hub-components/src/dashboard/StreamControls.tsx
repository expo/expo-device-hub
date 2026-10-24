import { type ReactNode } from "react";

import {
  areRecordingControlsLocked,
  type DeviceClipboardAction,
  type DeviceClipboardCapabilities,
  type DeviceScreenRecordingStatus,
} from "@expo/hub-client";
import {
  CONTROL_BUTTON_SIZE,
  CameraIcon,
  ClipboardPasteIcon,
  ControlButton,
  CopyIcon,
  Dropdown,
  DropdownItem,
  HomeIcon,
  RefreshIcon,
  RotateIcon,
  ThemeIcon,
  bg,
  border,
  radius,
  text,
} from "../primitives";
import { type ColorScheme } from "./data";

const GROUP_PADDING = 4;
const GROUP_GAP = 24;
const ICON_SIZE = 20;
const ICON_STROKE = 1.67;

/** Rendered height of the toolbar: a button plus the group's padding and hairline border. */
export const STREAM_CONTROLS_HEIGHT = CONTROL_BUTTON_SIZE + GROUP_PADDING * 2 + 2;

/** A pill that groups toolbar buttons on the shared element surface. */
function ControlGroup({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexShrink: 0,
        alignItems: "center",
        padding: GROUP_PADDING,
        boxSizing: "border-box",
        border: `1px solid ${border.default}`,
        borderRadius: radius.xl,
        backgroundColor: bg.element,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Controls under the device stream. Both platforms share one toolbar: a pill
 * with Save · Theme · Home · Reload, a Clipboard menu for a device with
 * clipboard support (Copy then Paste, as in serve-sim), plus a
 * separate Rotate button. Each button
 * shows its label as a tooltip on hover. Device-level actions (Android Back and
 * Recents keys, shutting down or removing the device) live in the inspector's
 * Device options section.
 *
 * "Reload" reloads the running React Native/Expo bundle via the active device
 * client. "Theme" toggles the **device's** system dark/light appearance (not
 * Hub's own theme).
 */
export function StreamControls({
  appearance,
  appearanceDisabled = false,
  onToggleAppearance,
  onHome,
  onReload,
  onRotate,
  onSave,
  recording = null,
  clipboard = false,
  clipboardPending = null,
  onPaste,
  onCopy,
}: {
  /** The device's current dark/light appearance; null while unknown. */
  appearance: ColorScheme | null;
  /** Whether appearance settings are unavailable or a change is pending. */
  appearanceDisabled?: boolean;
  /** Flip the device's system appearance (dark ↔ light). */
  onToggleAppearance: () => void;
  /** Press the device Home button. */
  onHome?: () => void;
  /** Reload the running React Native/Expo bundle. */
  onReload?: () => void;
  /** Rotate the device. */
  onRotate?: () => void;
  /** Save a screenshot of the device (triggers a file download). */
  onSave?: () => void;
  recording?: DeviceScreenRecordingStatus | null;
  /** The clipboard actions the device offers. Each one shows only when the device has it. */
  clipboard?: DeviceClipboardCapabilities;
  /** Disable both clipboard actions while either is in flight. */
  clipboardPending?: DeviceClipboardAction | null;
  /** Paste the browser clipboard into the device app. */
  onPaste?: () => void;
  /** Copy the text selected in the device app to the browser clipboard. */
  onCopy?: () => void;
}) {
  const recordingControlsLocked = areRecordingControlsLocked(recording);
  const themeDisabled = appearanceDisabled || appearance === null;
  const clipboardDisabled = clipboardPending !== null;
  return (
    <div
      role="toolbar"
      aria-label="Device controls"
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        alignItems: "center",
        columnGap: GROUP_GAP,
        rowGap: 8,
      }}
    >
      <ControlGroup>
        <ControlButton
          icon={<CameraIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Save"
          onClick={onSave}
        />
        <ControlButton
          icon={<ThemeIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Theme"
          role="switch"
          aria-checked={appearance === "dark"}
          disabled={themeDisabled}
          onClick={themeDisabled ? undefined : onToggleAppearance}
          style={themeDisabled ? { color: text.tertiary, cursor: "not-allowed" } : undefined}
        />
        <ControlButton
          icon={<HomeIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Home"
          onClick={onHome}
        />
        <ControlButton
          icon={<RefreshIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Reload"
          onClick={onReload}
        />
      </ControlGroup>
      {clipboard && (clipboard.paste || clipboard.copy) && (
        <ControlGroup>
          <Dropdown
            side="top"
            align="center"
            disabled={clipboardDisabled}
            trigger={
              <ControlButton
                icon={<ClipboardPasteIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
                label="Clipboard"
                disabled={clipboardDisabled}
                style={
                  clipboardDisabled ? { color: text.tertiary, cursor: "not-allowed" } : undefined
                }
              />
            }
          >
            {clipboard.copy && (
              <DropdownItem
                label="Copy from Simulator"
                Icon={CopyIcon}
                disabled={clipboardDisabled}
                onSelect={onCopy}
              />
            )}
            {clipboard.paste && (
              <DropdownItem
                label="Paste from Device"
                Icon={ClipboardPasteIcon}
                disabled={clipboardDisabled}
                onSelect={onPaste}
              />
            )}
          </Dropdown>
        </ControlGroup>
      )}
      <ControlGroup>
        <ControlButton
          icon={<RotateIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Rotate"
          tooltip={
            recording === "unknown"
              ? "Rotation is unavailable until recording status is known."
              : recordingControlsLocked
                ? "Rotation is unavailable while recording."
                : undefined
          }
          aria-disabled={recordingControlsLocked || undefined}
          onClick={recordingControlsLocked ? undefined : onRotate}
          style={
            recordingControlsLocked ? { color: text.tertiary, cursor: "not-allowed" } : undefined
          }
        />
      </ControlGroup>
    </div>
  );
}
