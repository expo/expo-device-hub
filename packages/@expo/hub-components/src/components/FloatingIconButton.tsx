import { type ButtonHTMLAttributes, forwardRef, type ReactNode, useState } from "react";

import { bg, icon as iconColor, radius } from "../theme/tokens";

/**
 * A plain 40px icon button for a corner of the canvas: no border, no background
 * until hovered. It shares its look with the floating sidebar toggle. The label is
 * the accessible name; touch layouts have no tooltip.
 */
export type FloatingIconButtonProps = {
  icon: ReactNode;
  label: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export const FloatingIconButton = forwardRef<HTMLButtonElement, FloatingIconButtonProps>(
  function FloatingIconButton(
    { icon, label, style, onMouseEnter, onMouseLeave, onMouseDown, onMouseUp, ...rest },
    ref,
  ) {
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);

    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        onMouseEnter={(event) => {
          setHovered(true);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setHovered(false);
          setPressed(false);
          onMouseLeave?.(event);
        }}
        onMouseDown={(event) => {
          setPressed(true);
          onMouseDown?.(event);
        }}
        onMouseUp={(event) => {
          setPressed(false);
          onMouseUp?.(event);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 40,
          height: 40,
          padding: 0,
          boxSizing: "border-box",
          border: "none",
          borderRadius: radius.lg,
          backgroundColor: hovered ? bg.element : "transparent",
          color: iconColor.default,
          cursor: "pointer",
          transition: "background-color 150ms ease, transform 100ms ease",
          transform: pressed ? "scale(0.98)" : undefined,
          ...style,
        }}
        {...rest}
      >
        {icon}
      </button>
    );
  },
);
