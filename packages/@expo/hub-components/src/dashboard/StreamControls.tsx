import { type ReactNode } from 'react';

import {
  CONTROL_BUTTON_SIZE,
  CameraIcon,
  ControlButton,
  HomeIcon,
  RefreshIcon,
  RotateIcon,
  ThemeIcon,
  bg,
  border,
  radius,
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
 * with Save · Theme · Home · Reload, plus a separate Rotate button. Each button
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
}) {
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
      <ControlGroup>
        <ControlButton
          icon={<RotateIcon size={ICON_SIZE} strokeWidth={ICON_STROKE} />}
          label="Rotate"
          onClick={onRotate}
        />
      </ControlGroup>
    </div>
  );
}
