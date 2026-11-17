import { type CSSProperties } from "react";

import { opacity } from "../primitives";

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
 * A compact range input for numeric inspector rows. The `.hub-slider` rules in
 * `theme.css` draw it in the look of the website's sliders: a thin track, and
 * a blue thumb with a white ring. The filled part of the track follows
 * `--hub-slider-fill`. `onAdjustStart`/`onAdjustEnd`
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
      className="hub-slider"
      style={
        {
          "--hub-slider-fill": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`,
          width,
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? opacity.disabled : 1,
        } as CSSProperties
      }
    />
  );
}
