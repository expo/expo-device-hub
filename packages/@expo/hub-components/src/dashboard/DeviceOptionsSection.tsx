import { useId, useState } from 'react';

import { type DeviceClient, type DeviceSettingKey } from '@expo/hub-client';
import { Select, type SelectOption } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { KeyboardSection } from './KeyboardSection';
import { SidebarActionButton } from './SidebarActionButton';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

const DEFAULT_VALUES: Record<DeviceSettingKey, string> = {
  appearance: 'light',
  network: 'on',
  'liquid-glass': 'clear',
  'color-filter': 'none',
  'text-size': 'large',
  'reduce-motion': 'off',
  'increase-contrast': 'off',
  'show-borders': 'off',
  'reduce-transparency': 'off',
  voiceover: 'off',
};

const APPEARANCE_OPTIONS: SelectOption[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const NETWORK_OPTIONS: SelectOption[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const LIQUID_GLASS_OPTIONS: SelectOption[] = [
  { value: 'clear', label: 'Clear' },
  { value: 'tinted', label: 'Tinted' },
];

const COLOR_FILTER_OPTIONS: SelectOption[] = [
  { value: 'none', label: 'None' },
  { value: 'grayscale', label: 'Grayscale' },
  { value: 'red-green', label: 'Red-green' },
  { value: 'green-red', label: 'Green-red' },
  { value: 'blue-yellow', label: 'Blue-yellow' },
];

const TEXT_SIZE_OPTIONS: SelectOption[] = [
  { value: 'extra-small', label: 'XS' },
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'extra-large', label: 'XL' },
  { value: 'extra-extra-large', label: '2XL' },
  { value: 'extra-extra-extra-large', label: '3XL' },
];

const ANDROID_TEXT_SIZE_OPTIONS: SelectOption[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'extra-large', label: 'XL' },
];

const SWITCH_OPTIONS: ReadonlyArray<{ key: DeviceSettingKey; label: string }> = [
  { key: 'reduce-motion', label: 'Reduce motion' },
  { key: 'increase-contrast', label: 'Increase contrast' },
  { key: 'show-borders', label: 'Show borders' },
  { key: 'reduce-transparency', label: 'Reduce transparency' },
  { key: 'voiceover', label: 'VoiceOver' },
];

const EMPTY_PENDING_SETTINGS: ReadonlySet<DeviceSettingKey> = new Set();

export const NO_DEVICE_FRAME_DESCRIPTION = 'No device frame for selected device.';

export type DeviceFrameOption = {
  available: boolean;
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
};

/**
 * Device-wide appearance, connectivity, and accessibility settings, plus iOS
 * keyboard controls, the viewer-local device frame option, and device-level
 * actions (Android Back and Recents keys, shutting down or removing the device).
 */
export function DeviceOptionsSection({
  client,
  deviceFrame,
  showDeviceSettings = true,
  onShutdown,
  onRemove,
}: {
  client?: DeviceClient;
  deviceFrame?: DeviceFrameOption;
  /** Whether backend-controlled appearance and accessibility settings are available. */
  showDeviceSettings?: boolean;
  /** Shut the device down on the host. */
  onShutdown?: () => void;
  /** Remove/delete the device on the host. Omit for physical devices. */
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(true);
  const unavailableFrameDescriptionId = useId();
  const settings = client?.deviceSettings ?? null;
  const pending = client?.deviceSettingsPending ?? EMPTY_PENDING_SETTINGS;
  const platform = client?.platform;

  function visible(key: DeviceSettingKey) {
    if (settings === null) return key === 'appearance' || platform === 'ios';
    return settings[key] !== undefined && settings[key] !== 'unsupported';
  }

  function value(key: DeviceSettingKey) {
    return settings?.[key] ?? DEFAULT_VALUES[key];
  }

  function disabled(key: DeviceSettingKey) {
    return settings === null || pending.has(key);
  }

  function setValue(key: DeviceSettingKey, nextValue: string) {
    if (settings !== null && !pending.has(key)) client?.setDeviceSetting(key, nextValue);
  }

  function settingSelect(key: DeviceSettingKey, label: string, options: SelectOption[]) {
    return (
      <SidebarRow label={label}>
        <Select
          ariaLabel={label}
          options={options}
          value={value(key)}
          disabled={disabled(key)}
          onChange={(nextValue) => setValue(key, nextValue)}
        />
      </SidebarRow>
    );
  }

  const keyboardVisible = showDeviceSettings && client?.platform === 'ios';

  return (
    <CollapsibleSection title="Device options" open={open} onOpenChange={setOpen}>
      {showDeviceSettings &&
        visible('appearance') &&
        settingSelect('appearance', 'Appearance', APPEARANCE_OPTIONS)}

      {showDeviceSettings &&
        platform === 'ios' &&
        visible('liquid-glass') &&
        settingSelect('liquid-glass', 'Liquid glass', LIQUID_GLASS_OPTIONS)}

      {showDeviceSettings &&
        platform === 'ios' &&
        visible('color-filter') &&
        settingSelect('color-filter', 'Color filter', COLOR_FILTER_OPTIONS)}

      {showDeviceSettings &&
        platform === 'android' &&
        visible('network') &&
        settingSelect('network', 'Network', NETWORK_OPTIONS)}

      {showDeviceSettings &&
        (platform === 'ios' || platform === 'android') &&
        visible('text-size') &&
        settingSelect(
          'text-size',
          'Text size',
          platform === 'android' ? ANDROID_TEXT_SIZE_OPTIONS : TEXT_SIZE_OPTIONS,
        )}

      {showDeviceSettings &&
        platform === 'ios' &&
        SWITCH_OPTIONS.map(({ key, label }) =>
          visible(key) ? (
            <SidebarRow key={key} label={label}>
              <SidebarSwitch
                checked={value(key) === 'on'}
                disabled={disabled(key)}
                label={label}
                onChange={(checked) => setValue(key, checked ? 'on' : 'off')}
              />
            </SidebarRow>
          ) : null,
        )}

      {deviceFrame && (
        <SidebarRow
          label="Show device frame"
          description={deviceFrame.available ? undefined : NO_DEVICE_FRAME_DESCRIPTION}
          descriptionId={deviceFrame.available ? undefined : unavailableFrameDescriptionId}>
          <SidebarSwitch
            checked={deviceFrame.available && deviceFrame.visible}
            disabled={!deviceFrame.available}
            label="Show device frame"
            descriptionId={deviceFrame.available ? undefined : unavailableFrameDescriptionId}
            onChange={deviceFrame.onVisibleChange}
          />
        </SidebarRow>
      )}

      {keyboardVisible && client && <KeyboardSection client={client} />}

      {client && platform === 'android' && (
        <>
          <SidebarRow label="Back button">
            <SidebarActionButton onClick={() => client.pressButton('back')}>Press</SidebarActionButton>
          </SidebarRow>
          <SidebarRow label="Recents button">
            <SidebarActionButton onClick={() => client.pressButton('recents')}>
              Press
            </SidebarActionButton>
          </SidebarRow>
        </>
      )}

      {client && onShutdown && (
        <SidebarRow label="Shut down device">
          <SidebarActionButton onClick={onShutdown}>Shut down</SidebarActionButton>
        </SidebarRow>
      )}

      {client && onRemove && (
        <SidebarRow label="Remove device">
          <SidebarActionButton destructive onClick={onRemove}>
            Remove
          </SidebarActionButton>
        </SidebarRow>
      )}
    </CollapsibleSection>
  );
}
