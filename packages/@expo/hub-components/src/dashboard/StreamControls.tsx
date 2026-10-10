import { type ReactNode } from 'react';

import {
  areRecordingControlsLocked,
  type DeviceClipboardCapabilities,
  type DeviceScreenRecordingStatus,
} from '@expo/hub-client';
import {
  CONTROL_BUTTON_SIZE,
  CameraIcon,
  ClipboardPasteIcon,
  ControlButton,
  CopyIcon,
  HomeIcon,
  RefreshIcon,
  RotateIcon,
  ThemeIcon,
  bg,
  border,
  radius,
  text,
} from '../primitives';
import { type ColorScheme } from './data';

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
        display: 'flex',
        alignItems: 'center',
        padding: GROUP_PADDING,
        boxSizing: 'border-box',
        border: `1px solid ${border.default}`,
        borderRadius: radius.xl,
        backgroundColor: bg.element,
      }}>
      {children}
    </div>
  );
}

/**
 * Controls under the device stream. Both platforms share one toolbar: a pill
 * with Save · Theme · Home · Reload, a Copy · Paste pill for a device with
 * clipboard support (serve-sim's Clipboard menu order, before Rotate), plus a
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
  onToggleAppearance,
  onHome,
  onReload,
  onRotate,
  onSave,
  recording = null,
  clipboard = false,
  onPaste,
  onCopy,
}: {
  /** The device's current dark/light appearance; null while unknown. */
  appearance: ColorScheme | null;
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
  /** Paste the browser clipboard into the device app. */
  onPaste?: () => void;
  /** Copy the text selected in the device app to the browser clipboard. */
  onCopy?: () => void;
}) {
  const recordingControlsLocked = areRecordingControlsLocked(recording);
  return (
    <div
      role="toolbar"
      aria-label="Device controls"
      style={{ display: 'flex', alignItems: 'center', gap: GROUP_GAP }}>
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
          aria-checked={appearance === 'dark'}
          onClick={onToggleAppearance}
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
          {clipboard.copy && (
            <ControlButton
              icon={<CopyIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              label="Copy from Simulator"
              onClick={onCopy}
            />
          )}
          {clipboard.paste && (
            <ControlButton
              icon={<ClipboardPasteIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
              label="Paste from Device"
              onClick={onPaste}
            />
          )}
        </ControlGroup>
      )}
      <ControlGroup>
        <ControlButton
          icon={<RotateIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Rotate"
          tooltip={
            recording === 'unknown'
              ? 'Rotation is unavailable until recording status is known.'
              : recordingControlsLocked ? 'Rotation is unavailable while recording.' : undefined
          }
          aria-disabled={recordingControlsLocked || undefined}
          onClick={recordingControlsLocked ? undefined : onRotate}
          style={recordingControlsLocked ? { color: text.tertiary, cursor: 'not-allowed' } : undefined}
        />
      </ControlGroup>
    </div>
  );
}
