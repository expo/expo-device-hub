import { type RefObject } from "react";

import { textSize, tone } from "../theme/tokens";
import { StatusDot } from "./StatusDot";

/** Reserved device-row status that appears without shifting the device name. */
export function AgentDeviceStatus({
  active,
  compact = false,
  labelRef,
}: {
  active: boolean;
  compact?: boolean;
  labelRef?: RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span
      aria-hidden={!active}
      data-agent-device-status={active ? "active" : "inactive"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 0 : 5,
        flexShrink: 0,
        visibility: active ? "visible" : "hidden",
        color: tone.info.text,
        ...textSize["2xs"],
      }}
    >
      <span data-agent-device-badge style={{ display: "flex", flexShrink: 0 }}>
        <StatusDot tone="info" size={7} />
      </span>
      <span
        ref={labelRef}
        data-agent-device-label
        style={{
          display: "inline-block",
          maxWidth: compact ? 0 : undefined,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        Used by agent
      </span>
    </span>
  );
}
