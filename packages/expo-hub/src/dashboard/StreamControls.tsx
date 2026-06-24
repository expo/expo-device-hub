import { ControlButton } from '../../components/ControlButton';
import { Dropdown } from '../../components/Dropdown';
import { DropdownItem } from '../../components/DropdownItem';
import { Switch } from '../../components/Switch';
import {
  CameraIcon,
  DotsIcon,
  HomeIcon,
  PowerIcon,
  RefreshIcon,
  RotateIcon,
  TrashIcon,
} from '../../components/icons';
import { type ColorScheme } from './useColorScheme';

/** Controls under the device stream: Reload, Theme switch, Home, Save, More. */
export function StreamControls({
  scheme,
  onToggleTheme,
  onHome,
}: {
  scheme: ColorScheme;
  onToggleTheme: () => void;
  /** Press the device Home button. */
  onHome?: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 24 }}>
      <ControlButton icon={<RefreshIcon />} label="Reload" />
      {/* Theme uses the reusable Switch instead of an icon circle. */}
      <Switch checked={scheme === 'dark'} onChange={onToggleTheme} label="Theme" />
      <ControlButton icon={<HomeIcon />} label="Home" variant="primary" onClick={onHome} />
      <ControlButton icon={<CameraIcon />} label="Save" />
      {/* More opens a popup menu of device actions, nudged toward the right. */}
      <Dropdown
        side="top"
        align="end"
        alignOffset={-80}
        // Don't return focus to the trigger on close, so it isn't left with a focus ring.
        onCloseAutoFocus={(event) => event.preventDefault()}
        trigger={<ControlButton icon={<DotsIcon />} label="More" />}>
        <DropdownItem label="Rotate device" Icon={RotateIcon} />
        <DropdownItem label="Shutdown" Icon={PowerIcon} />
        <DropdownItem label="Erase" Icon={TrashIcon} destructive />
      </Dropdown>
    </div>
  );
}
