import {
  useCallback,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

type ResizeDirection = "left" | "right" | "center-right" | "up";

export function resizedValue(
  initialSize: number,
  start: number,
  position: number,
  min: number,
  max: number,
  direction: ResizeDirection,
): number {
  const pointerDelta = position - start;
  const delta = direction === "right"
    ? pointerDelta
    : direction === "center-right"
      ? pointerDelta * 2
      : -pointerDelta;
  return Math.max(min, Math.min(max, initialSize + delta));
}

function useResizableSize(
  storageKey: string,
  defaultSize: number,
  min: number,
  max: number,
  direction: ResizeDirection,
) {
  const vertical = direction === "up";
  const clamp = useCallback(
    (value: number) => Math.max(min, Math.min(max, value)),
    [min, max],
  );
  const [size, setSize] = useState(() => {
    if (typeof window === "undefined") return defaultSize;
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultSize;
  });
  const viewportLimit = typeof window === "undefined"
    ? max
    : vertical ? window.innerHeight - 48 : window.innerWidth - 32;
  const effectiveSize = Math.max(min, Math.min(max, viewportLimit, size));

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const start = vertical ? event.clientY : event.clientX;
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      const sizeAt = (pointer: PointerEvent): number => {
        const position = vertical ? pointer.clientY : pointer.clientX;
        return resizedValue(effectiveSize, start, position, min, max, direction);
      };
      const move = (pointer: PointerEvent) => setSize(sizeAt(pointer));
      const finish = (pointer: PointerEvent) => {
        target.releasePointerCapture(pointer.pointerId);
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", finish);
        target.removeEventListener("pointercancel", finish);
        try {
          window.localStorage.setItem(storageKey, String(sizeAt(pointer)));
        } catch {}
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", finish);
      target.addEventListener("pointercancel", finish);
    },
    [direction, effectiveSize, max, min, storageKey, vertical],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const change = vertical
        ? event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0
        : event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
      if (change === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = clamp(effectiveSize + change);
      setSize(next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {}
    },
    [clamp, effectiveSize, storageKey, vertical],
  );

  return { size: effectiveSize, onPointerDown, onKeyDown };
}

export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
  grow: "left" | "right" = "left",
) {
  const { size, onPointerDown } = useResizableSize(storageKey, defaultWidth, min, max, grow);
  return { width: size, onPointerDown };
}

export function useResizableHeight(
  storageKey: string,
  defaultHeight: number,
  min: number,
  max: number,
) {
  const { size, onPointerDown } = useResizableSize(storageKey, defaultHeight, min, max, "up");
  return { height: size, onPointerDown };
}

export function useResizableCenteredWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
) {
  const { size, onPointerDown, onKeyDown } = useResizableSize(
    storageKey,
    defaultWidth,
    min,
    max,
    "center-right",
  );
  return { width: size, onPointerDown, onKeyDown };
}
