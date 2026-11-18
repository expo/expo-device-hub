import { useState } from "react";

import { type ConnectionStatus, type DeviceScreenRecordingStatus } from "@expo/hub-client";
import {
  bg,
  border,
  Button,
  BUTTON_HEIGHTS,
  type ButtonSize,
  font,
  LOADING_LABEL,
  radius,
  StatusDot,
  text,
  textSize,
  tone,
  type Tone,
  truncate,
} from "../primitives";
import { type Device } from "./data";

export type DeviceTitleProps = {
  device: Pick<Device, "id" | "name">;
  status: ConnectionStatus;
  recording?: DeviceScreenRecordingStatus | null;
};

const RECORDING_LABELS: Record<DeviceScreenRecordingStatus, string> = {
  unknown: "Checking recording status",
  waiting: "Starting recording",
  recording: "Recording",
  finalizing: "Finishing recording",
  complete: "Recording complete",
  failed: "Recording failed",
};

// Only the live state colors its label; the other labels stay secondary beside a colored dot.
// The dot of a status that is in progress pulses, as on the website; a status that ended is still.
const STATUS_APPEARANCE: Record<
  ConnectionStatus,
  { label: string; tone: Tone; labelColor: string; pulse: boolean }
> = {
  idle: { label: "Offline", tone: "danger", labelColor: text.secondary, pulse: false },
  // The screen's first load, the same label as its loading stage.
  connecting: { label: LOADING_LABEL, tone: "warning", labelColor: text.secondary, pulse: true },
  reconnecting: { label: "Reconnecting", tone: "warning", labelColor: text.secondary, pulse: true },
  streaming: { label: "Live", tone: "success", labelColor: tone.success.text, pulse: true },
  error: { label: "Error", tone: "danger", labelColor: text.secondary, pulse: false },
};

/** Diameter of the status dot without its ring: the website's `LiveIndicator` is 8px with it. */
const STATUS_DOT_SIZE = 4;

const DEVICE_TITLE_SIZE: ButtonSize = "xs";
/** Rendered height of the title pill, for layouts that reserve room above the frame. */
export const DEVICE_TITLE_HEIGHT = BUTTON_HEIGHTS[DEVICE_TITLE_SIZE];

/** Compact stream-status pill that toggles between a device's name and identifier. */
export function DeviceTitle({ device, status, recording = null }: DeviceTitleProps) {
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
            ...truncate,
            display: "block",
            flex: "1 1 auto",
            minWidth: 0,
            fontFamily: showingId ? font.mono : font.sans,
          }}
        >
          {label}
        </span>
      }
      rightSlot={
        <>
          <StatusDot tone={appearance.tone} size={STATUS_DOT_SIZE} ring pulse={appearance.pulse} />
          <span aria-live="polite" style={{ flexShrink: 0, color: appearance.labelColor }}>
            {/* The key makes a new label enter with the status animation. The live region stays. */}
            <span key={status} className="hub-status-label" style={{ display: "inline-block" }}>
              {appearance.label}
            </span>
          </span>
          {recording && (
            <span
              role="status"
              style={{
                flexShrink: 0,
                color:
                  recording === "recording" || recording === "failed"
                    ? tone.danger.text
                    : text.secondary,
              }}
            >
              {RECORDING_LABELS[recording]}
            </span>
          )}
        </>
      }
      style={{
        maxWidth: "min(100%, 320px)",
        minWidth: 0,
        flexShrink: 0,
        boxSizing: "border-box",
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
