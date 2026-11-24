import { type CSSProperties, useRef } from "react";

import { AndroidIcon, AppleIcon } from "./icons";
import { bg, radius, selection, text, textSize, truncate } from "../theme/tokens";
import { AgentDeviceStatus } from "./AgentDeviceStatus";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";
import { BUTTON_HEIGHTS } from "./Button";
import { UnsupportedDeviceWarning } from "./UnsupportedDeviceWarning";
import { useCompactAgentDeviceStatus } from "./useCompactAgentDeviceStatus";

/** Height of a device row in the dashboard design. */
export const DEVICE_LIST_ITEM_HEIGHT = 36;

/**
 * A selectable row in the simulators or emulators list, from the dashboard
 * design: the platform mark, the device name, and the OS version at the right.
 * An idle row is on the subtle surface. The selected row takes the selection
 * surface with its border.
 */
export type DeviceListItemProps = {
  name: string;
  version: string;
  /** Picks the mark before the name: the Apple logo or the Android head. */
  platform: "ios" | "android";
  /** Shows an accessible warning for a device type that Hub does not support or test. */
  unsupported?: boolean;
  usedByAgent?: boolean;
  selected?: boolean;
  onClick?: () => void;
};

export function DeviceListItem({
  name,
  version,
  platform,
  unsupported = false,
  usedByAgent = false,
  selected = false,
  onClick,
}: DeviceListItemProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const statusLabelRef = useRef<HTMLSpanElement>(null);
  const versionRef = useRef<HTMLSpanElement>(null);
  const compactAgentStatus = useCompactAgentDeviceStatus({
    buttonRef,
    nameRef,
    statusLabelRef,
    versionRef,
  });
  const PlatformIcon = platform === "ios" ? AppleIcon : AndroidIcon;

  const style: CSSProperties = {
    // A selected row keeps its fill under the pointer.
    ...pressableStyle({
      background: selected ? selection.bg : bg.subtle,
      hoverBackground: selected ? selection.bg : bg.element,
    }),
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    height: DEVICE_LIST_ITEM_HEIGHT,
    boxSizing: "border-box",
    padding: "0 8px",
    overflow: "hidden",
    // An idle row keeps the border's space, so selecting a row does not move its content.
    border: `1px solid ${selected ? selection.border : "transparent"}`,
    borderRadius: radius.lg,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };

  const row = (
    <button
      ref={buttonRef}
      type="button"
      className={PRESSABLE_CLASS}
      style={style}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${name}, ${version}${usedByAgent ? ", used by agent" : ""}`}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        <span
          aria-hidden="true"
          data-device-leading
          style={{ display: "flex", flex: "0 0 auto", color: text.secondary }}
        >
          <PlatformIcon size={16} />
        </span>
        {unsupported && (
          <span
            aria-hidden="true"
            data-device-leading
            style={{ width: BUTTON_HEIGHTS["2xs"], flex: "0 0 auto" }}
          />
        )}
        <span
          ref={nameRef}
          title={name}
          style={{
            ...textSize.sm,
            ...truncate,
            minWidth: 0,
            flex: "1 1 auto",
            fontWeight: 500,
            color: text.default,
          }}
        >
          {name}
        </span>
        <AgentDeviceStatus
          active={usedByAgent}
          compact={compactAgentStatus}
          labelRef={statusLabelRef}
        />
      </span>
      <span
        ref={versionRef}
        style={{
          ...textSize.sm,
          color: text.secondary,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {version}
      </span>
    </button>
  );

  if (!unsupported) return row;

  // @ref LLP 0000#device-support-warning — warning details must not select or boot the row
  return (
    <div style={{ position: "relative", minWidth: 0, width: "100%" }}>
      {row}
      <UnsupportedDeviceWarning name={name} />
    </div>
  );
}
