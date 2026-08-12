import { type DeviceStreamMode } from '@expo/hub-client';
import { ItemIndicator, RadioGroup, RadioItem } from '@radix-ui/react-dropdown-menu';
import { type CSSProperties, useId, useState } from 'react';

import {
  CheckIcon,
  ChevronDownIcon,
  Dropdown,
  bg,
  border,
  cx,
  icon,
  radius,
  text,
  textSize,
} from '../primitives';

export type StreamModeAvailability = Record<DeviceStreamMode, boolean>;

const STREAM_OPTIONS: Array<{ value: DeviceStreamMode; label: string }> = [
  { value: 'mjpeg', label: 'MJPEG' },
  { value: 'h264', label: 'H.264' },
  { value: 'webrtc', label: 'WebRTC' },
];

/** Viewer-local stream transport control for the right dashboard sidebar. */
export function StreamSection({
  mode,
  availability,
  onChange,
}: {
  mode: DeviceStreamMode;
  availability: StreamModeAvailability;
  onChange: (mode: DeviceStreamMode) => void;
}) {
  const labelId = useId();
  const valueId = useId();
  const helpId = useId();
  const restricted = !availability.h264 || !availability.webrtc;
  const [focused, setFocused] = useState(false);
  const selectedLabel = STREAM_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

  const triggerStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
    width: 92,
    height: 28,
    boxSizing: 'border-box',
    padding: '0 8px',
    border: `1px solid ${border.default}`,
    borderRadius: radius.lg,
    backgroundColor: bg.default,
    color: text.default,
    fontFamily: 'inherit',
    ...textSize.xs,
    outline: 'none',
    boxShadow: focused ? `0 0 0 3px ${bg.element}` : 'none',
    cursor: 'pointer',
    touchAction: 'manipulation',
    transition: 'box-shadow 150ms ease',
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.default }}>Stream</span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          gap: 8,
          color: text.secondary,
        }}>
        <span id={labelId} style={{ ...textSize.xs }}>
          Mode
        </span>
        <Dropdown
          align="end"
          sideOffset={6}
          aria-labelledby={labelId}
          style={{
            width: 92,
            minWidth: 92,
            boxSizing: 'border-box',
            padding: 4,
          }}
          trigger={
            <button
              type="button"
              aria-labelledby={`${labelId} ${valueId}`}
              aria-describedby={restricted ? helpId : undefined}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className="relative before:absolute before:inset-x-0 before:-inset-y-2 before:content-['']"
              style={triggerStyle}>
              <span id={valueId}>{selectedLabel}</span>
              <ChevronDownIcon size={14} color={icon.secondary} />
            </button>
          }>
          <RadioGroup value={mode} onValueChange={(value) => onChange(value as DeviceStreamMode)}>
            {STREAM_OPTIONS.map((option) => (
              <RadioItem
                key={option.value}
                value={option.value}
                disabled={!availability[option.value]}
                className={cx(
                  'relative z-40 flex cursor-pointer items-center justify-between rounded-lg px-2 outline-none select-none',
                  'data-[highlighted]:bg-hover',
                  'data-[disabled]:cursor-default data-[disabled]:opacity-60'
                )}
                style={{ minHeight: 44 }}>
                <span style={{ ...textSize.xs, color: text.default }}>{option.label}</span>
                <ItemIndicator asChild>
                  <span style={{ display: 'flex', color: icon.default }}>
                    <CheckIcon size={14} />
                  </span>
                </ItemIndicator>
              </RadioItem>
            ))}
          </RadioGroup>
        </Dropdown>
      </div>
      {restricted && (
        <span id={helpId} style={{ ...textSize.xs, color: text.tertiary }}>
          H.264 and WebRTC require localhost or HTTPS. MJPEG is used on insecure HTTP.
        </span>
      )}
    </section>
  );
}
