import { useState, type ReactNode } from 'react';

import { type DeviceClient, type DeviceSettingKey } from '@expo/hub-client';
import { SegmentedControl, border, text, textSize } from '../primitives';
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

function SettingGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        minWidth: 0,
        flexDirection: 'column',
        gap: 7,
        padding: '9px 0 10px',
        borderBottom: `1px solid ${border.secondary}`,
      }}
    >
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>{label}</span>
      <div style={{ minWidth: 0, overflowX: 'auto' }}>{children}</div>
    </div>
  );
}

/** Device-wide appearance and accessibility settings, plus the iOS keyboard controls. */
export function DeviceOptionsSection({ client }: { client?: DeviceClient }) {
  const [open, setOpen] = useState(true);
  const settings = client?.deviceSettings ?? null;
  const pending = client?.deviceSettingsPending ?? null;
  const platform = client?.platform;

  function visible(key: DeviceSettingKey) {
    if (settings === null) return key === 'appearance' || platform === 'ios';
    return settings[key] !== undefined && settings[key] !== 'unsupported';
  }

  function value(key: DeviceSettingKey) {
    return settings?.[key] ?? DEFAULT_VALUES[key];
  }

  function pillOptions<Value extends string>(
    options: ReadonlyArray<{ value: Value; label: string }>,
  ) {
    const disabled = settings === null || pending !== null;
    return options.map((option) => ({ ...option, disabled }));
  }

  function setValue(key: DeviceSettingKey, nextValue: string) {
    if (settings !== null && pending === null) client?.setDeviceSetting(key, nextValue);
  }

  return (
    <CollapsibleSection title="Device options" open={open} onOpenChange={setOpen}>
      {visible('appearance') && (
        <SettingGroup label="Appearance">
          <SegmentedControl
            ariaLabel="Appearance"
            options={pillOptions(APPEARANCE_OPTIONS)}
            value={value('appearance') as (typeof APPEARANCE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('appearance', nextValue)}
          />
        </SettingGroup>
      )}

      {platform === 'ios' && visible('liquid-glass') && (
        <SettingGroup label="Liquid glass">
          <SegmentedControl
            ariaLabel="Liquid glass"
            options={pillOptions(LIQUID_GLASS_OPTIONS)}
            value={value('liquid-glass') as (typeof LIQUID_GLASS_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('liquid-glass', nextValue)}
          />
        </SettingGroup>
      )}

      {platform === 'ios' && visible('color-filter') && (
        <SettingGroup label="Color filter">
          <SegmentedControl
            ariaLabel="Color filter"
            options={pillOptions(COLOR_FILTER_OPTIONS)}
            value={value('color-filter') as (typeof COLOR_FILTER_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('color-filter', nextValue)}
          />
        </SettingGroup>
      )}

      {platform === 'ios' && visible('text-size') && (
        <SettingGroup label="Text size">
          <SegmentedControl
            ariaLabel="Text size"
            options={pillOptions(TEXT_SIZE_OPTIONS)}
            value={value('text-size') as (typeof TEXT_SIZE_OPTIONS)[number]['value']}
            onChange={(nextValue) => setValue('text-size', nextValue)}
          />
        </SettingGroup>
      )}

      {platform === 'ios' &&
        SWITCH_OPTIONS.map(({ key, label }, index) =>
          visible(key) ? (
            <SidebarRow key={key} label={label} borderBottom={index < SWITCH_OPTIONS.length - 1}>
              <SidebarSwitch
                checked={value(key) === 'on'}
                disabled={settings === null || pending !== null}
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
