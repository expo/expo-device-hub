import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

import { icon } from '../theme/tokens';

/**
 * A thin, full-height divider that resizes an adjacent sidebar by dragging.
 *
 * It's invisible until the pointer hovers the seam (or a drag is in progress),
 * when a small grey grip fades in centered on the vertical line between the
 * sidebar and the device stream. The parent owns the width and positions the
 * handle on the boundary via `side` + `offset`; this component only reports how
 * far the pointer has travelled since the drag began, already signed so a
 * positive delta always means "make the sidebar wider".
 *
 * `side` selects which sidebar it borders: `'left'` sits on the left sidebar's
 * right edge (drag right → wider); `'right'` sits on the logs sidebar's left
 * edge (drag left → wider).
 */
export function ResizeHandle({
  side,
  offset,
  onResize,
  onResizeStart,
  onResizeEnd,
}: {
  side: 'left' | 'right';
  /** Distance in px of the boundary from the matching container edge — the current sidebar width. */
  offset: number;
  /** Pointer delta in px since drag start, signed so positive widens the sidebar. */
  onResize: (delta: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Drag state kept in a ref so pointermove never reads a stale closure.
  const startX = useRef(0);
  const draggingRef = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Primary button only — ignore right/middle clicks.
    if (event.button !== 0) return;
    event.preventDefault();
    startX.current = event.clientX;
    draggingRef.current = true;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    onResizeStart?.();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const raw = event.clientX - startX.current;
    // Dragging the left handle right grows the sidebar; the right handle is
    // mirrored, so dragging left (a negative raw delta) grows it instead.
    onResize(side === 'left' ? raw : -raw);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    onResizeEnd?.();
  }

  const visible = hovered || dragging;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        // Center the hit area on the boundary line so the grip straddles the seam.
        [side]: offset,
        transform: side === 'left' ? 'translateX(-50%)' : 'translateX(50%)',
        width: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        cursor: 'col-resize',
        // Keep the drag reliable on trackpads/touch by suppressing scroll gestures.
        touchAction: 'none',
        // Above the stream card, below the collapsed-sidebar overlays (z-index 10+).
        zIndex: 5,
      }}>
      {/* The small grey grip — the affordance shown on the seam. */}
      <div
        style={{
          width: 4,
          height: 40,
          borderRadius: 999,
          backgroundColor: dragging ? icon.secondary : icon.tertiary,
          opacity: visible ? 1 : 0,
          transition: 'opacity 120ms ease, background-color 120ms ease',
        }}
      />
    </div>
  );
}
