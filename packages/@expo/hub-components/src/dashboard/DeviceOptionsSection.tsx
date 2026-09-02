import { useId, useState } from 'react';

import { type DeviceClient, type DeviceSettingKey } from '@expo/hub-client';
import { SegmentedControl } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { KeyboardSection } from './KeyboardSection';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

const DEFAULT_VALUES: Record<DeviceSettingKey, string> = {
  appearance: 'light',
  network: 'on',
  'liquid-glass': 'clear',
  'color-filter': 'none',
  'text-size': 'large',
  'display-size': 'medium',
  'reduce-motion': 'off',
  'bold-text': 'off',
  'increase-contrast': 'off',
  'show-borders': 'off',
  'reduce-transparency': 'off',
  voiceover: 'off',
};

const APPEARANCE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

const NETWORK_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

const LIQUID_GLASS_OPTIONS = [
  { value: 'clear', label: 'Clear' },
  { value: 'tinted', label: 'Tinted' },
] as const;

const COLOR_FILTER_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'grayscale', label: 'Gray' },
  { value: 'red-green', label: 'R-G' },
  { value: 'green-red', label: 'G-R' },
  { value: 'blue-yellow', label: 'B-Y' },
] as const;

const TEXT_SIZE_OPTIONS = [
  { value: 'extra-small', label: 'XS' },
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'extra-large', label: 'XL' },
  { value: 'extra-extra-large', label: '2XL' },
  { value: 'extra-extra-extra-large', label: '3XL' },
] as const;

const ANDROID_TEXT_SIZE_OPTIONS = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'extra-large', label: 'XL' },
] as const;

const ANDROID_DISPLAY_SIZE_OPTIONS = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'extra-large', label: 'XL' },
] as const;

const SWITCH_OPTIONS: ReadonlyArray<{ key: DeviceSettingKey; label: string }> = [
  { key: 'reduce-motion', label: 'Reduce motion' },
  { key: 'bold-text', label: 'Bold text' },
  { key: 'increase-contrast', label: 'Increase contrast' },
  { key: 'show-borders', label: 'Show borders' },
  { key: 'reduce-transparency', label: 'Reduce transparency' },
  { key: 'voiceover', label: 'VoiceOver' },
];

const SETTING_ORDER: ReadonlyArray<DeviceSettingKey> = [
  'appearance',
  'network',
  'liquid-glass',
  'color-filter',
  'text-size',
  'display-size',
  ...SWITCH_OPTIONS.map(({ key }) => key),
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
 * keyboard controls and the viewer-local device frame option.
 */
export function DeviceOptionsSection({
  client,
  deviceFrame,
  showDeviceSettings = true,
}: {
  client?: DeviceClient;
  deviceFrame?: DeviceFrameOption;
  /** Whether backend-controlled appearance and accessibility settings are available. */
  showDeviceSettings?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const unavailableFrameDescriptionId = useId();
  const displaySizeDescriptionId = useId();
  const settings = client?.deviceSettings ?? null;
  const pending = client?.deviceSettingsPending ?? EMPTY_PENDING_SETTINGS;
  const platform = client?.platform;
  const displayWidthDp = client?.displayWidthDp ?? null;

  function visible(key: DeviceSettingKey) {
    if (settings === null) return key === 'appearance' || platform === 'ios';
    return settings[key] !== undefined && settings[key] !== 'unsupported';
  }

  function value(key: DeviceSettingKey) {
    return settings?.[key] ?? DEFAULT_VALUES[key];
  }

  function pillOptions<Value extends string>(
    key: DeviceSettingKey,
    options: ReadonlyArray<{ value: Value; label: string }>,
  ) {
    const disabled = settings === null || pending.has(key);
    return options.map((option) => ({ ...option, disabled }));
  }

  function setValue(key: DeviceSettingKey, nextValue: string) {
    if (settings !== null && !pending.has(key)) client?.setDeviceSetting(key, nextValue);
  }

  const keyboardVisible = showDeviceSettings && client?.platform === 'ios';
  const visibleSettingKeys = showDeviceSettings ? SETTING_ORDER.filter(visible) : [];

  function hasFollowingRow(key: DeviceSettingKey) {
    return Boolean(deviceFrame) || keyboardVisible || visibleSettingKeys.at(-1) !== key;
  }

  return (
    <CollapsibleSection title="Device options" open={open} onOpenChange={setOpen}>
      {showDeviceSettings && visible('appearance') && (
        <SidebarRow compact label="Appearance" borderBottom={hasFollowingRow('appearance')}>
          <SegmentedControl
            ariaLabel="Appearance"
            options={pillOptions('appearance', APPEARANCE_OPTIONS)}
            value={value('appearance') as (typeof APPEARANCE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('appearance', nextValue)}
          />
        </SidebarRow>
      )}

      {showDeviceSettings && platform === 'ios' && visible('liquid-glass') && (
        <SidebarRow compact label="Liquid glass" borderBottom={hasFollowingRow('liquid-glass')}>
          <SegmentedControl
            ariaLabel="Liquid glass"
            options={pillOptions('liquid-glass', LIQUID_GLASS_OPTIONS)}
            value={value('liquid-glass') as (typeof LIQUID_GLASS_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('liquid-glass', nextValue)}
          />
        </SidebarRow>
      )}

      {showDeviceSettings && platform === 'ios' && visible('color-filter') && (
        <SidebarRow compact label="Color filter" borderBottom={hasFollowingRow('color-filter')}>
          <SegmentedControl
            ariaLabel="Color filter"
            options={pillOptions('color-filter', COLOR_FILTER_OPTIONS)}
            value={value('color-filter') as (typeof COLOR_FILTER_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('color-filter', nextValue)}
          />
        </SidebarRow>
      )}

      {showDeviceSettings && platform === 'android' && visible('network') && (
        <SidebarRow compact label="Network" borderBottom={hasFollowingRow('network')}>
          <SegmentedControl
            ariaLabel="Network"
            options={pillOptions('network', NETWORK_OPTIONS)}
            value={value('network') as (typeof NETWORK_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('network', nextValue)}
          />
        </SidebarRow>
      )}

      {showDeviceSettings &&
        (platform === 'ios' || platform === 'android') &&
        visible('text-size') && (
          <SidebarRow compact label="Text size" borderBottom={hasFollowingRow('text-size')}>
            <SegmentedControl
              ariaLabel="Text size"
              options={pillOptions(
                'text-size',
                platform === 'android' ? ANDROID_TEXT_SIZE_OPTIONS : TEXT_SIZE_OPTIONS,
              )}
              value={value('text-size')}
              onChange={(nextValue) => setValue('text-size', nextValue)}
            />
          </SidebarRow>
        )}

      {showDeviceSettings && platform === 'android' && visible('display-size') && (
        <SidebarRow
          compact
          label="Display size"
          description={displayWidthDp === null ? undefined : `sw${displayWidthDp}dp`}
          descriptionId={displayWidthDp === null ? undefined : displaySizeDescriptionId}
          borderBottom={hasFollowingRow('display-size')}>
          <SegmentedControl
            ariaLabel="Display size"
            ariaDescribedBy={displayWidthDp === null ? undefined : displaySizeDescriptionId}
            options={pillOptions('display-size', ANDROID_DISPLAY_SIZE_OPTIONS)}
            value={value('display-size') as (typeof ANDROID_DISPLAY_SIZE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('display-size', nextValue)}
          />
        </SidebarRow>
      )}

      {showDeviceSettings &&
        SWITCH_OPTIONS.map(({ key, label }) =>
          visible(key) ? (
            <SidebarRow key={key} label={label} borderBottom={hasFollowingRow(key)}>
              <SidebarSwitch
                checked={value(key) === 'on'}
                disabled={settings === null || pending.has(key)}
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
          descriptionId={deviceFrame.available ? undefined : unavailableFrameDescriptionId}
          borderBottom={keyboardVisible}>
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
    </CollapsibleSection>
  );
}
