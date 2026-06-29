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
  RotateIcon,
  Switch,
  ThemeIcon,
  TrashIcon,
} from '../primitives';
import { type ColorScheme, type Platform } from './data';

/**
 * Controls under the device stream. The layout is platform-specific:
 *  - Android: Save · Back · Home · Recents · More — with Reload + Theme moved
 *    into the More menu (Android exposes hardware Back/Recents keys).
 *  - iOS: Save · Theme · Home · Reload · More.
 */
export function StreamControls({
  platform,
  physical,
  scheme,
  onToggleTheme,
  onHome,
  onBack,
  onRecents,
}: {
  platform: Platform;
  physical: boolean;
  scheme: ColorScheme;
  onToggleTheme: () => void;
  /** Press the device Home button. */
  onHome?: () => void;
  /** Press the Android Back key. */
  onBack?: () => void;
  /** Press the Android Recents key. */
  onRecents?: () => void;
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
      {isAndroid && <DropdownItem label="Reload" Icon={RefreshIcon} />}
      {isAndroid && (
        <DropdownItem
          label={scheme === 'dark' ? 'Light mode' : 'Dark mode'}
          Icon={ThemeIcon}
          onSelect={onToggleTheme}
        />
      )}
      <DropdownItem label="Rotate device" Icon={RotateIcon} />
      <DropdownItem label="Shutdown" Icon={PowerIcon} />
      {!physical && <DropdownItem label="Erase" Icon={TrashIcon} destructive />}
    </Dropdown>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
      <ControlButton icon={<CameraIcon />} label="Save" />

      {isAndroid ? (
        <ControlButton icon={<BackIcon />} label="Back" onClick={onBack} />
      ) : (
        // Theme uses the reusable Switch instead of an icon circle.
        <Switch checked={scheme === 'dark'} onChange={onToggleTheme} label="Theme" />
      )}

      <ControlButton icon={<HomeIcon />} label="Home" variant="primary" onClick={onHome} />

      {isAndroid ? (
        <ControlButton icon={<RecentsIcon />} label="Recents" onClick={onRecents} />
      ) : (
        <ControlButton icon={<RefreshIcon />} label="Reload" />
      )}

      {more}
    </div>
  );
}
