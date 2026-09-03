import { type ReactNode } from "react";

import { bg, border, font, radius, shadow, text, textSize } from "../primitives";

export function SidebarSectionHeading({ children }: { children: ReactNode }) {
  return (
    <span style={{ ...textSize.xs, display: "block", fontFamily: font.mono, color: text.tertiary }}>
      {children}
    </span>
  );
}

/**
 * A label on the left and its control on the right. Rows stack without
 * dividers — their vertical padding alone spaces them out.
 */
export function SidebarRow({
  label,
  children,
  description,
  descriptionId,
}: {
  label: string;
  children: ReactNode;
  /** Optional explanatory copy shown directly beneath the label. */
  description?: string;
  /** Associates the explanatory copy with an interactive row control. */
  descriptionId?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        minHeight: 28,
        boxSizing: "border-box",
        padding: "12px 0",
      }}
    >
      <span style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 2 }}>
        <span style={{ ...textSize.sm, color: text.secondary }}>{label}</span>
        {description && (
          <span id={descriptionId} style={{ ...textSize.xs, color: text.tertiary }}>
            {description}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

const SWITCH_WIDTH = 36;
const SWITCH_HEIGHT = 20;
const SWITCH_INSET = 2;
const SWITCH_KNOB = SWITCH_HEIGHT - SWITCH_INSET * 2;
const SWITCH_TRANSITION = "180ms cubic-bezier(.4, 0, .2, 1)";

/** A compact on/off toggle for boolean inspector rows. */
export function SidebarSwitch({
  checked,
  disabled = false,
  label,
  descriptionId,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  descriptionId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={descriptionId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: SWITCH_WIDTH,
        height: SWITCH_HEIGHT,
        padding: SWITCH_INSET - 1,
        boxSizing: "border-box",
        flexShrink: 0,
        border: `1px solid ${checked ? "transparent" : border.default}`,
        borderRadius: radius.full,
        backgroundColor: checked ? text.default : bg.hover,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: `background-color ${SWITCH_TRANSITION}, border-color ${SWITCH_TRANSITION}`,
      }}
    >
      <span
        style={{
          display: "block",
          width: SWITCH_KNOB,
          height: SWITCH_KNOB,
          borderRadius: radius.full,
          backgroundColor: bg.default,
          boxShadow: shadow.xs,
          transform: `translateX(${checked ? SWITCH_WIDTH - SWITCH_KNOB - SWITCH_INSET * 2 : 0}px)`,
          transition: `transform ${SWITCH_TRANSITION}`,
        }}
      />
    </button>
  );
}
