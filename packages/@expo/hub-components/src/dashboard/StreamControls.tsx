import {
  BackIcon,
  CameraIcon,
  ControlButton,
  DotsIcon,
  Dropdown,
  DropdownItem,
  HomeIcon,
  PowerIcon,
  RecentsIcon,
  RefreshIcon,
  Switch,
  TrashIcon,
} from '../primitives';
import { type ColorScheme, type Platform } from './data';

/**
 * Controls under the device stream. Both platforms share one bar:
 *  - Save · Theme · Home · Reload · More.
 *  - Android's hardware Back + Recents keys live in the More menu (iOS lacks them).
 *
 * "Reload" reloads the running React Native/Expo bundle via the active device
 * client. "Theme" toggles the **device's** system dark/light appearance (not
 * Hub's own theme).
 */
export function StreamControls({
  platform,
  physical,
  appearance,
  onToggleAppearance,
  onHome,
  onBack,
  onRecents,
  onReload,
  onSave,
  onShutdown,
  onRemove,
}: {
  platform: Platform;
  physical: boolean;
  /** The device's current dark/light appearance; null while unknown. */
  appearance: ColorScheme | null;
  /** Flip the device's system appearance (dark ↔ light). */
  onToggleAppearance: () => void;
  /** Press the device Home button. */
  onHome?: () => void;
  /** Press the Android Back key. */
  onBack?: () => void;
  /** Press the Android Recents key. */
  onRecents?: () => void;
  /** Reload the running React Native/Expo bundle. */
  onReload?: () => void;
  /** Save a screenshot of the device (triggers a file download). */
  onSave?: () => void;
  /** Shut the device down (More menu). */
  onShutdown?: () => void;
  /** Remove/delete the device (More menu; hidden for physical devices). */
  onRemove?: () => void;
}) {
  const isAndroid = platform === 'android';

  const more = (
    <Dropdown
      side="top"
      align="end"
      alignOffset={-80}
      // Don't return focus to the trigger on close, so it isn't left with a focus ring.
      onCloseAutoFocus={(event) => event.preventDefault()}
      trigger={<ControlButton icon={<DotsIcon />} label="More" />}>
      {isAndroid && <DropdownItem label="Back" Icon={BackIcon} onSelect={onBack} />}
      {isAndroid && <DropdownItem label="Recents" Icon={RecentsIcon} onSelect={onRecents} />}
      <DropdownItem label="Shutdown" Icon={PowerIcon} onSelect={onShutdown} />
      {!physical && (
        <DropdownItem label="Remove" Icon={TrashIcon} destructive onSelect={onRemove} />
      )}
    </Dropdown>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
      <ControlButton icon={<CameraIcon />} label="Save" onClick={onSave} />

      {/* Theme toggle — same on both platforms; uses the reusable Switch. */}
      <Switch checked={appearance === 'dark'} onChange={onToggleAppearance} label="Theme" />

      <ControlButton icon={<HomeIcon />} label="Home" variant="primary" onClick={onHome} />

      <ControlButton icon={<RefreshIcon />} label="Reload" onClick={onReload} />

      {more}
    </div>
  );
}
