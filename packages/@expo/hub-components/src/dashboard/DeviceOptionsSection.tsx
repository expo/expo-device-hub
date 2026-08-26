import { useState } from 'react';

import { type DeviceClient, type DeviceSettingKey } from '@expo/hub-client';
import { SegmentedControl } from '../primitives';
import { CollapsibleSection } from './CollapsibleSection';
import { KeyboardSection } from './KeyboardSection';
import { SidebarRow, SidebarSwitch } from './SidebarRow';

const DEFAULT_VALUES: Record<DeviceSettingKey, string> = {
  appearance: 'light',
  'liquid-glass': 'clear',
  'color-filter': 'none',
  'text-size': 'large',
  'reduce-motion': 'off',
  'increase-contrast': 'off',
  'show-borders': 'off',
  'reduce-transparency': 'off',
  voiceover: 'off',
};

const APPEARANCE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
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

const SWITCH_OPTIONS: ReadonlyArray<{ key: DeviceSettingKey; label: string }> = [
  { key: 'reduce-motion', label: 'Reduce motion' },
  { key: 'increase-contrast', label: 'Increase contrast' },
  { key: 'show-borders', label: 'Show borders' },
  { key: 'reduce-transparency', label: 'Reduce transparency' },
  { key: 'voiceover', label: 'VoiceOver' },
];

const SETTING_ORDER: ReadonlyArray<DeviceSettingKey> = [
  'appearance',
  'liquid-glass',
  'color-filter',
  'text-size',
  ...SWITCH_OPTIONS.map(({ key }) => key),
];

const EMPTY_PENDING_SETTINGS: ReadonlySet<DeviceSettingKey> = new Set();

/** Device-wide appearance and accessibility settings, plus the iOS keyboard controls. */
export function DeviceOptionsSection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(true);
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

  const keyboardVisible = client?.platform === 'ios';
  const visibleSettingKeys = SETTING_ORDER.filter(visible);

  function hasFollowingRow(key: DeviceSettingKey) {
    return keyboardVisible || visibleSettingKeys.at(-1) !== key;
  }

  return (
    <CollapsibleSection title="Device options" open={open} onOpenChange={setOpen}>
      {visible('appearance') && (
        <SidebarRow compact label="Appearance" borderBottom={hasFollowingRow('appearance')}>
          <SegmentedControl
            ariaLabel="Appearance"
            compact
            options={pillOptions('appearance', APPEARANCE_OPTIONS)}
            value={value('appearance') as (typeof APPEARANCE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('appearance', nextValue)}
          />
        </SidebarRow>
      )}

      {platform === 'ios' && visible('liquid-glass') && (
        <SidebarRow compact label="Liquid glass" borderBottom={hasFollowingRow('liquid-glass')}>
          <SegmentedControl
            ariaLabel="Liquid glass"
            compact
            options={pillOptions('liquid-glass', LIQUID_GLASS_OPTIONS)}
            value={value('liquid-glass') as (typeof LIQUID_GLASS_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('liquid-glass', nextValue)}
          />
        </SidebarRow>
      )}

      {platform === 'ios' && visible('color-filter') && (
        <SidebarRow compact label="Color filter" borderBottom={hasFollowingRow('color-filter')}>
          <SegmentedControl
            ariaLabel="Color filter"
            compact
            options={pillOptions('color-filter', COLOR_FILTER_OPTIONS)}
            value={value('color-filter') as (typeof COLOR_FILTER_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('color-filter', nextValue)}
          />
        </SidebarRow>
      )}

      {platform === 'ios' && visible('text-size') && (
        <SidebarRow compact label="Text size" borderBottom={hasFollowingRow('text-size')}>
          <SegmentedControl
            ariaLabel="Text size"
            compact
            options={pillOptions('text-size', TEXT_SIZE_OPTIONS)}
            value={value('text-size') as (typeof TEXT_SIZE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('text-size', nextValue)}
          />
        </SidebarRow>
      )}

      {platform === 'ios' &&
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

      {client?.platform === 'ios' && <KeyboardSection client={client} />}
    </CollapsibleSection>
  );
}
