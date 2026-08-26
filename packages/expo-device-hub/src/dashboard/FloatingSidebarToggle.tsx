import { SidebarToggle } from '@expo/hub-components';

const DEFAULT_INSET = 24;
const COLLISION_INSET = 80;
const COLLISION_BUFFER = 40;

/** Move sideways only when an overlay's close control would occupy the same corner. */
export function floatingSidebarToggleInset(
  oppositeOverlay: boolean,
  containerWidth: number,
  oppositeSidebarWidth: number
): number {
  return oppositeOverlay && containerWidth < oppositeSidebarWidth + COLLISION_BUFFER
    ? COLLISION_INSET
    : DEFAULT_INSET;
}

export function FloatingSidebarToggle({
  side,
  inset = DEFAULT_INSET,
  onClick,
}: {
  side: 'left' | 'right';
  inset?: number;
  onClick: () => void;
}) {
  return (
    <div
      data-floating-sidebar-toggle={side}
      style={{ position: 'absolute', top: 28, [side]: inset, zIndex: 15 }}>
      <SidebarToggle floating side={side} onClick={onClick} />
    </div>
  );
}
