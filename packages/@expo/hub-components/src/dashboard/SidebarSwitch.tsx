import {
  DisabledControlHint,
  PRESSABLE_CLASS,
  accent,
  bg,
  border,
  motion,
  opacity,
  pressableStyle,
  radius,
  shadow,
} from "../primitives";

// The website's `Switch` at `size="sm"`: a 36 x 20 track and a 16px knob.
const SWITCH_WIDTH = 36;
const SWITCH_HEIGHT = 20;
const SWITCH_KNOB = 16;
/** Space between the knob and the inner edge of the track's border: the website's `m-px`. */
const SWITCH_INSET = 1;
const SWITCH_TRAVEL = SWITCH_WIDTH - SWITCH_KNOB - 2 * SWITCH_INSET - 2;

/**
 * A compact on/off toggle for boolean inspector rows, in the look of the
 * website's `Switch`: a gray track that turns blue when on.
 */
export function SidebarSwitch({
  checked,
  disabled = false,
  disabledReason,
  label,
  descriptionId,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  /** Why the switch is locked. A locked switch shows it in a tooltip. */
  disabledReason?: string;
  label: string;
  descriptionId?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <DisabledControlHint reason={disabled ? disabledReason : undefined} label={label}>
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
          ...pressableStyle({ background: checked ? accent.default : bg.hover, pressScale: 1 }),
          display: "flex",
          width: SWITCH_WIDTH,
          height: SWITCH_HEIGHT,
          padding: 0,
          boxSizing: "border-box",
          flexShrink: 0,
          alignItems: "center",
          border: `1px solid ${checked ? accent.default : border.default}`,
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
            margin: SWITCH_INSET,
            borderRadius: radius.full,
            backgroundColor: accent.knob,
            boxShadow: shadow.xs,
            transform: `translateX(${checked ? SWITCH_TRAVEL : 0}px)`,
            transition: `transform ${motion.base} ${motion.easeInOut}`,
          }}
        />
      </button>
    </DisabledControlHint>
  );
}
