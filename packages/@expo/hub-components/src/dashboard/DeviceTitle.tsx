import { useState } from 'react';

import { type DeviceClient, type ScreenRecordingPhase } from '@expo/hub-client';
import {
  bg,
  border,
  Button,
  BUTTON_HEIGHTS,
  type ButtonSize,
  font,
  icon,
  radius,
  text,
  textSize,
} from '../primitives';
import { type Device } from './data';

export type DeviceTitleProps = {
  device: Pick<Device, 'id' | 'name'>;
  status: DeviceClient['stream']['status'];
  /** The host recording feature; omitted or unsupported shows no recording label. */
  recording?: DeviceClient['screenRecording'];
};

const RECORDING_LABELS: Record<ScreenRecordingPhase | 'checking', string> = {
  checking: 'Checking recording status',
  waiting: 'Starting recording',
  recording: 'Recording',
  finalizing: 'Finishing recording',
  complete: 'Recording complete',
  failed: 'Recording failed',
};

const STATUS_APPEARANCE: Record<
  DeviceClient['stream']['status'],
  { label: string; dotColor: string; ringColor: string; labelColor: string }
> = {
  resolving: {
    label: 'Checking availability',
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  unsupported: {
    label: 'Offline',
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
  idle: {
    label: 'Offline',
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
  loading: {
    label: 'Starting',
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  reconnecting: {
    label: 'Reconnecting',
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  ready: {
    label: 'Live',
    dotColor: text.success,
    ringColor: border.success,
    labelColor: text.success,
  },
  error: {
    label: 'Error',
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
};

const DEVICE_TITLE_SIZE: ButtonSize = 'xs';
/** Rendered height of the title pill, for layouts that reserve room above the frame. */
export const DEVICE_TITLE_HEIGHT = BUTTON_HEIGHTS[DEVICE_TITLE_SIZE];

/** Compact stream-status pill that toggles between a device's name and identifier. */
export function DeviceTitle({ device, status, recording }: DeviceTitleProps) {
  // A recording feature without a phase yet is still being checked.
  const recordingLabel =
    !recording || recording.status === 'unsupported' ? null : (recording.data ?? 'checking');
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const showingId = revealedId === device.id;
  const label = showingId ? device.id : device.name;
  const appearance = STATUS_APPEARANCE[status];

  return (
    <Button
      theme="tertiary"
      size={DEVICE_TITLE_SIZE}
      onClick={() => setRevealedId(showingId ? null : device.id)}
      leftSlot={
        <span
          title={label}
          style={{
            display: 'block',
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: showingId ? font.mono : font.sans,
          }}>
          {label}
        </span>
      }
      rightSlot={
        <>
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              boxSizing: 'content-box',
              border: `2px solid ${appearance.ringColor}`,
              borderRadius: radius.full,
              backgroundColor: appearance.dotColor,
            }}
          />
          <span aria-live="polite" style={{ flexShrink: 0, color: appearance.labelColor }}>
            {appearance.label}
          </span>
          {recordingLabel && (
            <span
              role="status"
              style={{
                flexShrink: 0,
                color:
                  recordingLabel === 'recording' || recordingLabel === 'failed'
                    ? text.danger
                    : text.secondary,
              }}>
              {RECORDING_LABELS[recordingLabel]}
            </span>
          )}
        </>
      }
      style={{
        maxWidth: 'min(100%, 320px)',
        minWidth: 0,
        flexShrink: 0,
        boxSizing: 'border-box',
        gap: 6,
        paddingInline: 12,
        borderWidth: 0.5,
        borderColor: border.default,
        borderRadius: radius.full,
        fontSize: textSize.sm.fontSize,
        fontWeight: 500,
        // Sits on the gray stream canvas, so it takes the sidebar surface color.
        backgroundColor: bg.default,
      }}
    />
  );
}
