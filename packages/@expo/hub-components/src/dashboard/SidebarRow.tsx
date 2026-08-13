import { type ReactNode } from "react";

import { bg, border, radius, shadow, text, textSize } from "../primitives";

export function SidebarRow({
  label,
  children,
  borderBottom = true,
}: {
  label: string;
  children: ReactNode;
  borderBottom?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "11px 0",
        borderBottom: borderBottom ? `1px solid ${border.secondary}` : undefined,
      }}
    >
      <span style={{ ...textSize.sm, flex: 1, fontWeight: 500, color: text.default }}>{label}</span>
      {children}
    </div>
  );
}

export function SidebarSwitch({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        width: 44,
        height: 26,
        padding: 3,
        boxSizing: "border-box",
        flexShrink: 0,
        border: 0,
        borderRadius: radius.full,
        backgroundColor: checked ? text.default : bg.selected,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background-color 180ms cubic-bezier(.4, 0, .2, 1)",
      }}
    >
      <span
        style={{
          display: "block",
          width: 20,
          height: 20,
          borderRadius: radius.full,
          backgroundColor: bg.default,
          boxShadow: shadow.xs,
          transform: `translateX(${checked ? 18 : 0}px)`,
          transition: "transform 180ms cubic-bezier(.4, 0, .2, 1)",
        }}
      />
    </button>
  );
}
