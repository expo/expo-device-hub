import { type CSSProperties, useState } from "react";

import { bg, icon as iconColor, radius } from "../theme/tokens";
import { CloseIcon, SidebarIcon } from "./icons";

/**
 * Toggle for showing/hiding a sidebar. `floating` is the larger standalone button
 * shown while the sidebar is collapsed; both variants are plain — no border, no
 * background, just a hover fill. `side` mirrors the glyph so it points at the
 * sidebar it controls; pass `"right"` for the right-hand sidebar.
 */
export function SidebarToggle({
  onClick,
  floating = false,
  side = "left",
  icon = "sidebar",
}: {
  onClick: () => void;
  floating?: boolean;
  /** Which sidebar it controls — mirrors the glyph to point that way. */
  side?: "left" | "right";
  /**
   * `"close"` swaps the sidebar glyph for an X, for a sidebar that covers the screen
   * and is dismissed rather than collapsed.
   */
  icon?: "sidebar" | "close";
}) {
  const [hovered, setHovered] = useState(false);
  const [pressed, setPressed] = useState(false);

  const style: CSSProperties = floating
    ? {
        width: 40,
        height: 40,
        borderRadius: radius.lg,
        border: "none",
        backgroundColor: hovered ? bg.element : "transparent",
      }
    : {
        width: 32,
        height: 32,
        borderRadius: radius.md,
        border: "none",
        backgroundColor: hovered ? bg.element : "transparent",
      };

  return (
    <button
      type="button"
      aria-label={icon === "close" ? "Close sidebar" : "Toggle sidebar"}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "pointer",
        boxSizing: "border-box",
        transition: "background-color 150ms ease, transform 100ms ease",
        transform: pressed ? "scale(0.98)" : undefined,
        ...style,
      }}
    >
      {icon === "close" ? (
        <CloseIcon size={20} color={iconColor.default} />
      ) : (
        <SidebarIcon
          size={20}
          color={iconColor.default}
          style={side === "right" ? { transform: "scaleX(-1)" } : undefined}
        />
      )}
    </button>
  );
}
