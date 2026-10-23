import { type ReactNode } from "react";

import { bg, border, radius, shadow, text, textSize } from "../primitives";

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
        <span style={{ ...textSize.sm, fontWeight: 500, color: text.secondary }}>{label}</span>
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

const SLIDER_ADJUST_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * A compact range input for numeric inspector rows. `onAdjustStart`/`onAdjustEnd`
 * bracket a pointer drag or key hold, so a caller can keep showing the dragged
 * value while each step awaits the device's acknowledgement.
 */
export function SidebarSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  valueText,
  disabled = false,
  width = 120,
  onChange,
  onAdjustStart,
  onAdjustEnd,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  valueText?: string;
  disabled?: boolean;
  width?: number;
  onChange: (value: number) => void;
  onAdjustStart?: () => void;
  onAdjustEnd?: () => void;
}) {
  return (
    <input
      type="range"
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        onAdjustStart?.();
      }}
      onPointerUp={onAdjustEnd}
      onPointerCancel={onAdjustEnd}
      onKeyDown={(event) => {
        if (SLIDER_ADJUST_KEYS.has(event.key)) onAdjustStart?.();
      }}
      onKeyUp={onAdjustEnd}
      onBlur={onAdjustEnd}
      style={{
        width,
        margin: 0,
        flexShrink: 0,
        accentColor: text.default,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    />
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
