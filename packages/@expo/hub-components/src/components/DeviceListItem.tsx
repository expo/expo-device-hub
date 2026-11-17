import { type CSSProperties, useRef } from "react";

import { WarningIcon } from "./icons";
import { bg, radius, text, textSize, tone, truncate } from "../theme/tokens";
import { AgentDeviceStatus } from "./AgentDeviceStatus";
import { PRESSABLE_CLASS, pressableStyle } from "./pressable";
import { useCompactAgentDeviceStatus } from "./useCompactAgentDeviceStatus";

/**
 * A selectable row in the simulators list ("list button"). Selected rows use the
 * `hover` surface, idle rows the `subtle` surface — matching the Figma states.
 */
export type DeviceListItemProps = {
  name: string;
  version: string;
  /** Shows an accessible warning for a device type that Hub does not support or test. */
  unsupported?: boolean;
  usedByAgent?: boolean;
  selected?: boolean;
  onClick?: () => void;
};

export function DeviceListItem({
  name,
  version,
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

  const style: CSSProperties = {
    // A selected row keeps its fill under the pointer.
    ...pressableStyle({
      background: selected ? bg.hover : undefined,
      hoverBackground: selected ? bg.hover : bg.element,
    }),
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    padding: 16,
    overflow: "hidden",
    border: "none",
    borderRadius: radius.xl,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };

  return (
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
          gap: 8,
          flex: "1 1 auto",
          minWidth: 0,
          overflow: "hidden",
        }}
      >
        {unsupported && (
          <span
            role="img"
            aria-label="Unsupported or untested device"
            title="This device type is unsupported or untested."
            style={{ display: "flex", flex: "0 0 auto", color: tone.warning.icon }}
          >
            <WarningIcon size={16} />
          </span>
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
          fontWeight: 500,
          color: text.secondary,
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
      >
        {version}
      </span>
    </button>
  );
}
