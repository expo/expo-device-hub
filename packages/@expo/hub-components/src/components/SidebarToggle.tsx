import { CloseIcon, SidebarIcon } from "./icons";
import { IconButton } from "./IconButton";

/**
 * Toggle for showing/hiding a sidebar. `floating` is the larger standalone button
 * shown while the sidebar is collapsed. `side` mirrors the glyph so it points at
 * the sidebar it controls; pass `"right"` for the right-hand sidebar.
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
  return (
    <IconButton
      label={icon === "close" ? "Close sidebar" : "Toggle sidebar"}
      size={floating ? 40 : 32}
      onClick={onClick}
      icon={
        icon === "close" ? (
          <CloseIcon size={20} />
        ) : (
          <SidebarIcon
            size={20}
            style={side === "right" ? { transform: "scaleX(-1)" } : undefined}
          />
        )
      }
    />
  );
}
