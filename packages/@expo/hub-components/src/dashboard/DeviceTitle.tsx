import { Content, Description, Root, Title, Trigger } from "@radix-ui/react-dialog";
import { type CSSProperties, type ReactNode, useState } from "react";

import { type ConnectionStatus, type DeviceScreenRecordingStatus } from "@expo/hub-client";
import {
  bg,
  border,
  Button,
  BUTTON_HEIGHTS,
  type ButtonSize,
  font,
  heading,
  icon,
  InfoIcon,
  LOADING_LABEL,
  radius,
  shadow,
  text,
  textSize,
} from "../primitives";
import { type Device } from "./data";

export type DeviceTitleProps = {
  device: Pick<Device, "id" | "name">;
  status: ConnectionStatus;
  recording?: DeviceScreenRecordingStatus | null;
  /**
   * The emulator renders on the CPU although the host has a usable GPU. While
   * the stream is live, the status shows a warning that opens its details.
   */
  renderingOnCpu?: boolean;
};

const RECORDING_LABELS: Record<DeviceScreenRecordingStatus, string> = {
  unknown: "Checking recording status",
  waiting: "Starting recording",
  recording: "Recording",
  finalizing: "Finishing recording",
  complete: "Recording complete",
  failed: "Recording failed",
};

type StatusAppearance = { label: string; dotColor: string; ringColor: string; labelColor: string };

const STATUS_APPEARANCE: Record<ConnectionStatus, StatusAppearance> = {
  idle: {
    label: "Offline",
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
  // The screen's first load, the same label as its spinner.
  connecting: {
    label: LOADING_LABEL,
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  reconnecting: {
    label: "Reconnecting",
    dotColor: icon.warning,
    ringColor: border.warning,
    labelColor: text.secondary,
  },
  streaming: {
    label: "Live",
    dotColor: text.success,
    ringColor: border.success,
    labelColor: text.success,
  },
  error: {
    label: "Error",
    dotColor: icon.danger,
    ringColor: border.danger,
    labelColor: text.secondary,
  },
};

/**
 * Live, but rendered on the CPU. The label stays "Live" and the dot does not
 * pulse, so it reads apart from the amber Loading and Reconnecting states; the
 * info icon is a cue besides the color.
 */
const CPU_RENDERING_APPEARANCE: StatusAppearance = {
  label: "Live",
  dotColor: icon.warning,
  ringColor: border.warning,
  labelColor: text.warning,
};

export const CPU_RENDERING_STATUS_LABEL = "Live, rendering on the CPU. Show details";
export const CPU_RENDERING_TITLE = "Rendering on the CPU";
export const CPU_RENDERING_TEXT =
  "This emulator renders on the CPU, so the stream is usually slow: 15 to 30 FPS. Reboot the emulator with GPU rendering (automatic when booting through the Hub) for 60 FPS.";

const DEVICE_TITLE_SIZE: ButtonSize = "xs";
/** Rendered height of the title pill, for layouts that reserve room above the frame. */
export const DEVICE_TITLE_HEIGHT = BUTTON_HEIGHTS[DEVICE_TITLE_SIZE];

const PILL_STYLE: CSSProperties = {
  maxWidth: "min(100%, 320px)",
  minWidth: 0,
  flexShrink: 0,
  boxSizing: "border-box",
  fontSize: textSize.sm.fontSize,
  fontWeight: 500,
  // Sits on the gray stream canvas, so it takes the sidebar surface color.
  backgroundColor: bg.default,
};

/** Half of the 6px gap between the pill's items, on each side of the split. */
const SPLIT_INSET = 3;
const PILL_INSET = 12;

/** One part of the split pill: the pill draws the border and the surface. */
const SEGMENT_STYLE: CSSProperties = {
  height: "100%",
  gap: 6,
  borderWidth: 0,
  borderRadius: radius.full,
  fontSize: textSize.sm.fontSize,
  fontWeight: 500,
  backgroundColor: "transparent",
};

/** Compact stream-status pill that toggles between a device's name and identifier. */
export function DeviceTitle({
  device,
  status,
  recording = null,
  renderingOnCpu = false,
}: DeviceTitleProps) {
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const showingId = revealedId === device.id;
  const label = showingId ? device.id : device.name;
  const toggleId = () => setRevealedId(showingId ? null : device.id);

  const name = (
    <span
      title={label}
      style={{
        display: "block",
        flex: "1 1 auto",
        minWidth: 0,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontFamily: showingId ? font.mono : font.sans,
      }}
    >
      {label}
    </span>
  );
  const recordingLabel = recording && (
    <span
      role="status"
      style={{
        flexShrink: 0,
        color: recording === "recording" || recording === "failed" ? text.danger : text.secondary,
      }}
    >
      {RECORDING_LABELS[recording]}
    </span>
  );

  if (status === "streaming" && renderingOnCpu) {
    return <CpuRenderingTitle name={name} onToggleId={toggleId} recordingLabel={recordingLabel} />;
  }

  const appearance = STATUS_APPEARANCE[status];
  return (
    <Button
      theme="tertiary"
      size={DEVICE_TITLE_SIZE}
      onClick={toggleId}
      leftSlot={name}
      rightSlot={
        <>
          <StatusDot appearance={appearance} />
          <StatusLabel appearance={appearance} />
          {recordingLabel}
        </>
      }
      style={{
        ...PILL_STYLE,
        gap: 6,
        paddingInline: PILL_INSET,
        borderWidth: 0.5,
        borderColor: border.default,
        borderRadius: radius.full,
      }}
    />
  );
}

/**
 * The pill of a live stream that renders on the CPU. The name keeps its own
 * button, and the status is a second button that opens a non-modal popover.
 * Radix's trigger gives it `aria-haspopup`, `aria-expanded` and `aria-controls`;
 * Escape and a click outside close the popover, and Escape returns the focus.
 */
// @ref LLP 0024#warning — the status pill carries the warning; a recommendation only
function CpuRenderingTitle({
  name,
  onToggleId,
  recordingLabel,
}: {
  name: ReactNode;
  onToggleId: () => void;
  recordingLabel: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Root open={open} onOpenChange={setOpen} modal={false}>
      <div
        style={{
          ...PILL_STYLE,
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          height: DEVICE_TITLE_HEIGHT,
          border: `0.5px solid ${border.default}`,
          borderRadius: radius.full,
        }}
      >
        <Button
          theme="tertiary"
          size={DEVICE_TITLE_SIZE}
          onClick={onToggleId}
          leftSlot={name}
          style={{
            ...SEGMENT_STYLE,
            flex: "0 1 auto",
            minWidth: 0,
            paddingInline: `${PILL_INSET}px ${SPLIT_INSET}px`,
          }}
        />
        <Trigger asChild>
          <Button
            theme="tertiary"
            size={DEVICE_TITLE_SIZE}
            aria-label={CPU_RENDERING_STATUS_LABEL}
            rightSlot={
              <>
                <StatusDot appearance={CPU_RENDERING_APPEARANCE} />
                <StatusLabel appearance={CPU_RENDERING_APPEARANCE} />
                <InfoIcon color={icon.warning} />
              </>
            }
            style={{
              ...SEGMENT_STYLE,
              flexShrink: 0,
              paddingInline: `${SPLIT_INSET}px ${recordingLabel ? SPLIT_INSET : PILL_INSET}px`,
            }}
          />
        </Trigger>
        {recordingLabel && (
          <span style={{ display: "flex", paddingInline: `${SPLIT_INSET}px ${PILL_INSET}px` }}>
            {recordingLabel}
          </span>
        )}
        {/* Mounted only while open: there is no exit animation to wait for. */}
        {open && (
          <Content
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              zIndex: 1,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              width: "max-content",
              maxWidth: "min(280px, calc(100vw - 32px))",
              boxSizing: "border-box",
              padding: "12px 16px",
              border: `1px solid ${border.default}`,
              borderRadius: radius.lg,
              boxShadow: shadow.md,
              backgroundColor: bg.default,
              textAlign: "left",
              whiteSpace: "normal",
              outline: "none",
            }}
          >
            <Title style={{ ...heading.sm, margin: 0, color: text.default }}>
              {CPU_RENDERING_TITLE}
            </Title>
            <Description
              style={{ ...textSize.xs, fontWeight: 400, margin: 0, color: text.secondary }}
            >
              {CPU_RENDERING_TEXT}
            </Description>
          </Content>
        )}
      </div>
    </Root>
  );
}

function StatusDot({ appearance }: { appearance: StatusAppearance }) {
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        flexShrink: 0,
        boxSizing: "content-box",
        border: `2px solid ${appearance.ringColor}`,
        borderRadius: radius.full,
        backgroundColor: appearance.dotColor,
      }}
    />
  );
}

function StatusLabel({ appearance }: { appearance: StatusAppearance }) {
  return (
    <span aria-live="polite" style={{ flexShrink: 0, color: appearance.labelColor }}>
      {appearance.label}
    </span>
  );
}
