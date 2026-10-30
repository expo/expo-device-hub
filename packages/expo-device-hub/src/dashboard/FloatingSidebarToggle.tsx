import { SidebarToggle } from "@expo/hub-components";

const DEFAULT_INSET = 24;
const DEFAULT_TOP = 28;
const COLLISION_INSET = 80;
const COLLISION_BUFFER = 40;

/** Move sideways only when an overlay's close control would occupy the same corner. */
export function floatingSidebarToggleInset(
  oppositeOverlay: boolean,
  containerWidth: number,
  oppositeSidebarWidth: number,
): number {
  return oppositeOverlay && containerWidth < oppositeSidebarWidth + COLLISION_BUFFER
    ? COLLISION_INSET
    : DEFAULT_INSET;
}

/**
 * Whether the floating toggle shows: only while its sidebar is closed, and not while a
 * phone's keyboard is up, when the device takes the room.
 */
export function floatingSidebarToggleVisible({
  sidebarOpen,
  mobile,
  keyboardRaised,
}: {
  sidebarOpen: boolean;
  mobile: boolean;
  keyboardRaised: boolean;
}): boolean {
  return !sidebarOpen && !(mobile && keyboardRaised);
}

export function FloatingSidebarToggle({
  side,
  inset = DEFAULT_INSET,
  top = DEFAULT_TOP,
  onClick,
}: {
  side: "left" | "right";
  inset?: number;
  /** Distance from the top edge in px. A phone passes a smaller one. */
  top?: number;
  onClick: () => void;
}) {
  return (
    <div
      data-floating-sidebar-toggle={side}
      style={{ position: "absolute", top, [side]: inset, zIndex: 15 }}
    >
      <SidebarToggle floating side={side} onClick={onClick} />
    </div>
  );
}
