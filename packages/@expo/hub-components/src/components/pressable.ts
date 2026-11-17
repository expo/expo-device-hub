import { type CSSProperties } from "react";

/**
 * The class of a control whose hover, press and keyboard focus states come
 * from the `.hub-pressable` rules in `theme/theme.css`, not from React state.
 */
export const PRESSABLE_CLASS = "hub-pressable";

export type PressableColors = {
  /** Resting background. Transparent when omitted. */
  background?: string;
  /** Background under the pointer. The resting background when omitted. */
  hoverBackground?: string;
  /** Resting box shadow. The keyboard focus ring is drawn above it. */
  shadow?: string;
  /** Scale while pressed. Pass 1 for a control that must not move, such as a text field. */
  pressScale?: number;
};

/**
 * The custom properties that the `.hub-pressable` rules read. Spread the
 * result into the inline style of an element that has {@link PRESSABLE_CLASS}.
 * The rules own `background-color`, `box-shadow`, `transform`, `transition`
 * and `outline`, so the same inline style must not set them.
 */
export function pressableStyle({
  background,
  hoverBackground,
  shadow,
  pressScale,
}: PressableColors = {}): CSSProperties {
  return {
    "--hub-pressable-bg": background,
    "--hub-pressable-bg-hover": hoverBackground,
    "--hub-pressable-shadow": shadow,
    "--hub-pressable-press-scale": pressScale,
  } as CSSProperties;
}
