/**
 * Drag handle at a panel's outer edge that folds the iPhone Duo model, ported
 * from serve-sim's `src/client/components/duo-hinge-handle.tsx`
 * (@expo/serve-sim 0.5.0). The scene positions it; this only draws and
 * handles the keyboard.
 */

import { useState, type RefObject } from 'react';

type HandlePhase = 'idle' | 'hover' | 'drag';

// serve-sim's resize-handle stroke palette, shared by its hinge handles.
const MAIN_STROKE: Record<HandlePhase, string> = {
  idle: '#686e78',
  hover: '#b7bbc2',
  drag: '#f4f6fa',
};
const MAIN_STROKE_WIDTH: Record<HandlePhase, number> = {
  idle: 2.65,
  hover: 4.15,
  drag: 4.65,
};

export function DuoHingeHandle({
  handleRef,
  side,
  angle,
  onChange,
}: {
  handleRef: RefObject<HTMLDivElement | null>;
  side: 'left' | 'right';
  angle?: number;
  onChange?: (angle: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const phase: HandlePhase = dragging ? 'drag' : hovered || focused ? 'hover' : 'idle';
  return (
    <div
      ref={handleRef}
      data-duo-hinge-handle={side}
      role="slider"
      aria-label={side === 'left' ? 'Fold device' : 'Fold device from opposite edge'}
      aria-description="Drag the edge to fold or unfold. Use arrow keys for 5 degrees, Shift for 15 degrees, Home to close, or End to open."
      aria-valuemin={0}
      aria-valuemax={180}
      aria-valuenow={Math.round(angle ?? 0)}
      aria-valuetext={`${Math.round(angle ?? 0)} degrees`}
      aria-disabled={!onChange}
      tabIndex={onChange ? 0 : -1}
      title="Drag to fold or unfold"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onPointerDownCapture={(event) => {
        if (event.button === 0 && onChange) setDragging(true);
      }}
      onPointerUpCapture={() => setDragging(false)}
      onPointerCancelCapture={() => setDragging(false)}
      onLostPointerCaptureCapture={() => setDragging(false)}
      onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible'))}
      onBlur={() => {
        setFocused(false);
        setDragging(false);
      }}
      onKeyDown={(event) => {
        if (!onChange || event.metaKey || event.ctrlKey || event.altKey) return;
        const step = event.shiftKey ? 15 : 5;
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? 180
              : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
                ? (angle ?? 0) - step
                : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                  ? (angle ?? 0) + step
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        onChange(Math.max(0, Math.min(180, next)));
      }}
      style={{
        position: 'absolute',
        width: 48,
        height: 60,
        zIndex: 25,
        visibility: onChange ? undefined : 'hidden',
        touchAction: 'none',
        cursor: dragging ? 'grabbing' : 'grab',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <svg
        width="48"
        height="60"
        viewBox="0 0 48 60"
        fill="none"
        aria-hidden="true"
        style={{ pointerEvents: 'none', overflow: 'visible' }}
      >
        {focused && (
          <path d="M20 16C28 22 28 38 20 44" stroke="#0a84ff" strokeWidth="12" strokeLinecap="round" />
        )}
        <path
          d="M20 16C28 22 28 38 20 44"
          stroke="#34363b"
          strokeWidth={MAIN_STROKE_WIDTH[phase] + 2.2}
          strokeLinecap="round"
        />
        <path
          d="M20 16C28 22 28 38 20 44"
          stroke={MAIN_STROKE[phase]}
          strokeWidth={MAIN_STROKE_WIDTH[phase]}
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
