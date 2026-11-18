import {
  PRESSABLE_CLASS,
  bg,
  border,
  motion,
  opacity,
  pressableStyle,
  radius,
  shadow,
  text,
} from "../primitives";

const SWITCH_WIDTH = 36;
const SWITCH_HEIGHT = 20;
const SWITCH_INSET = 2;
const SWITCH_KNOB = SWITCH_HEIGHT - SWITCH_INSET * 2;

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
      // The class draws the keyboard focus ring and eases the track color.
      className={PRESSABLE_CLASS}
      style={{
        ...pressableStyle({ background: checked ? text.default : bg.hover, pressScale: 1 }),
        width: SWITCH_WIDTH,
        height: SWITCH_HEIGHT,
        padding: SWITCH_INSET - 1,
        boxSizing: "border-box",
        flexShrink: 0,
        border: `1px solid ${checked ? "transparent" : border.default}`,
        borderRadius: radius.full,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? opacity.disabled : 1,
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
          transition: `transform ${motion.base} ${motion.easeInOut}`,
        }}
      />
    </button>
  );
}
