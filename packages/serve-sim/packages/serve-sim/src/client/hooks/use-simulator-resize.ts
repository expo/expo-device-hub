import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import {
  SIMULATOR_RESIZE_DETENT_RADIUS,
  SIMULATOR_RESIZE_MIN_WIDTH,
  SIMULATOR_RESIZE_MOMENTUM_S,
  SIMULATOR_RESIZE_PERSIST_DEBOUNCE_MS,
  SIMULATOR_RESIZE_SCALE_STORAGE_KEY,
  SIMULATOR_RESIZE_SPRING_DAMPING,
  SIMULATOR_RESIZE_SPRING_STIFFNESS,
  SIMULATOR_RESIZE_VELOCITY_HISTORY_MS,
  SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
  clampSimulatorFrameWidth,
  estimateReleaseVelocity,
  getSimulatorFrameMaxWidth,
  restoredSimulatorFrameWidth,
  roundToDevicePixel,
  rubberBandResistance,
  snapToDetent,
  springTo,
} from "../utils/simulator-resize";

type DragStart = {
  pointerId: number;
  startX: number;
  startY: number;
  startWidth: number;
  currentWidth: number;
};

type Sample = { t: number; x: number };

export function useSimulatorResize({
  defaultWidth,
  viewportWidth,
  viewportHeight,
  aspectRatio,
  reservedForChrome = SIMULATOR_RESIZE_VIEWPORT_HEIGHT_RESERVED_FOR_CHROME,
  onStart,
}: {
  defaultWidth: number;
  viewportWidth: number;
  viewportHeight: number;
  aspectRatio: number;
  reservedForChrome?: number;
  onStart: () => void;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const isResizing = dragWidth !== null;
  const [isInertia, setIsInertia] = useState(false);
  const [handleHovered, setHandleHovered] = useState(false);
  const dragStartRef = useRef<DragStart | null>(null);
  const samplesRef = useRef<Sample[]>([]);
  const rafRef = useRef<number | null>(null);
  const tweenCancelRef = useRef<(() => void) | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);

  const readPreferredWidth = useCallback(() => {
    if (typeof window === "undefined") return defaultWidth;
    // A non-finite scale (storage threw / empty / NaN) falls back to defaultWidth
    // inside restoredSimulatorFrameWidth, so both paths share one call.
    let scale = NaN;
    try {
      const raw = window.localStorage.getItem(SIMULATOR_RESIZE_SCALE_STORAGE_KEY);
      scale = raw != null ? Number(raw) : NaN;
    } catch {}
    return restoredSimulatorFrameWidth(defaultWidth, 0, 0, aspectRatio, scale, reservedForChrome);
  }, [aspectRatio, defaultWidth, reservedForChrome]);
  const initialPreferredWidth = useMemo(() => readPreferredWidth(), [readPreferredWidth]);
  // @ref LLP 0003#preview-layout — constrain display size without erasing the preferred width
  const [preferredWidth, setPreferredWidth] = useState<number | null>(initialPreferredWidth);
  const preferredWidthRef = useRef<number | null>(initialPreferredWidth);
  const restoredDefaultWidthRef = useRef(defaultWidth);

  const maxWidth = getSimulatorFrameMaxWidth(
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
    reservedForChrome,
  );
  const minWidth = Math.min(SIMULATOR_RESIZE_MIN_WIDTH, maxWidth);

  const width = dragWidth ?? preferredWidth ?? defaultWidth;
  const committedWidth = clampSimulatorFrameWidth(
    width,
    defaultWidth,
    viewportWidth,
    viewportHeight,
    aspectRatio,
    reservedForChrome,
  );

  const writePreferredWidth = useCallback((next: number) => {
    const rounded = roundToDevicePixel(next);
    preferredWidthRef.current = rounded;
    setPreferredWidth(rounded);
  }, []);

  const persistNow = useCallback(
    (value: number) => {
      if (typeof window === "undefined" || defaultWidth <= 0) return;
      const drag = dragStartRef.current;
      const changed = drag !== null && drag.currentWidth !== drag.startWidth;
      const clamped = clampSimulatorFrameWidth(
        value,
        defaultWidth,
        changed ? viewportWidth : 0,
        changed ? viewportHeight : 0,
        aspectRatio,
        reservedForChrome,
      );
      try {
        window.localStorage.setItem(
          SIMULATOR_RESIZE_SCALE_STORAGE_KEY,
          String(clamped / defaultWidth),
        );
      } catch {}
    },
    [aspectRatio, defaultWidth, reservedForChrome, viewportHeight, viewportWidth],
  );

  const schedulePersist = useCallback(
    (value: number) => {
      if (persistTimerRef.current != null) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        persistNow(value);
      }, SIMULATOR_RESIZE_PERSIST_DEBOUNCE_MS);
    },
    [persistNow],
  );

  useEffect(() => {
    if (restoredDefaultWidthRef.current === defaultWidth) return;
    restoredDefaultWidthRef.current = defaultWidth;
    writePreferredWidth(readPreferredWidth());
  }, [defaultWidth, readPreferredWidth, writePreferredWidth]);

  useEffect(() => {
    if (!isResizing && !isInertia) return;
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    const prevWebkitUserSelect = document.body.style.webkitUserSelect;
    document.body.style.cursor = "nwse-resize";
    document.body.style.userSelect = "none";
    document.body.style.webkitUserSelect = "none";
    return () => {
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
      document.body.style.webkitUserSelect = prevWebkitUserSelect;
    };
  }, [isResizing, isInertia]);

  // The debounced persist would otherwise be lost if the tab closes mid-interaction.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const flush = () => {
      const drag = dragStartRef.current;
      const w =
        drag && drag.currentWidth !== drag.startWidth
          ? drag.currentWidth
          : preferredWidthRef.current;
      if (w == null) return;
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      persistNow(w);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [persistNow]);

  const displayWidthFromRaw = useCallback(
    (raw: number): number => {
      if (raw > maxWidth) return maxWidth + rubberBandResistance(raw - maxWidth, maxWidth);
      if (raw < minWidth) return minWidth - rubberBandResistance(minWidth - raw, maxWidth);
      return raw;
    },
    [maxWidth, minWidth],
  );

  const cancelTween = useCallback(() => {
    if (tweenCancelRef.current) {
      tweenCancelRef.current();
      tweenCancelRef.current = null;
    }
    setIsInertia(false);
  }, []);

  const recordSample = useCallback((x: number) => {
    const t = performance.now();
    const buf = samplesRef.current;
    buf.push({ t, x });
    while (buf.length > 1 && t - buf[0]!.t > SIMULATOR_RESIZE_VELOCITY_HISTORY_MS) buf.shift();
  }, []);

  const scheduleMove = useCallback(
    (rawWidth: number) => {
      const display = displayWidthFromRaw(rawWidth);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const drag = dragStartRef.current;
        if (!drag) return;
        drag.currentWidth = roundToDevicePixel(display);
        setDragWidth(drag.currentWidth);
        recordSample(drag.currentWidth);
      });
    },
    [displayWidthFromRaw, recordSample],
  );

  const beginDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      cancelTween();
      const startWidth = committedWidth;
      dragStartRef.current = {
        pointerId,
        startX: clientX,
        startY: clientY,
        startWidth,
        currentWidth: startWidth,
      };
      setDragWidth(startWidth);
      samplesRef.current = [{ t: performance.now(), x: startWidth }];
      onStart();
    },
    [cancelTween, committedWidth, onStart],
  );

  const endDrag = useCallback(() => {
    const start = dragStartRef.current;
    if (!start) return;
    dragStartRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (start.pointerId >= 0) {
      const handle = handleRef.current;
      if (handle?.hasPointerCapture(start.pointerId)) {
        handle.releasePointerCapture(start.pointerId);
      }
    }
    setDragWidth(null);
    if (start.currentWidth === start.startWidth) {
      samplesRef.current = [];
      return;
    }

    const fromDisplay = start.currentWidth;
    const velocity = estimateReleaseVelocity(samplesRef.current);
    samplesRef.current = [];

    const projected = clampSimulatorFrameWidth(
      fromDisplay + velocity * SIMULATOR_RESIZE_MOMENTUM_S,
      defaultWidth,
      viewportWidth,
      viewportHeight,
      aspectRatio,
      reservedForChrome,
    );
    const target = roundToDevicePixel(
      snapToDetent(projected, [defaultWidth], SIMULATOR_RESIZE_DETENT_RADIUS),
    );

    // Under reduced-motion, or when there's nothing meaningful to animate, snap directly.
    const trivial = Math.abs(fromDisplay - target) < 0.5 && Math.abs(velocity) < 8;
    if (reducedMotion || trivial) {
      writePreferredWidth(target);
      schedulePersist(target);
      return;
    }

    writePreferredWidth(fromDisplay);
    setIsInertia(true);
    tweenCancelRef.current = springTo({
      from: fromDisplay,
      to: target,
      velocity,
      stiffness: SIMULATOR_RESIZE_SPRING_STIFFNESS,
      damping: SIMULATOR_RESIZE_SPRING_DAMPING,
      onUpdate: writePreferredWidth,
      onComplete: () => {
        tweenCancelRef.current = null;
        setIsInertia(false);
        schedulePersist(target);
      },
    });
  }, [
    aspectRatio,
    defaultWidth,
    reducedMotion,
    reservedForChrome,
    schedulePersist,
    viewportHeight,
    viewportWidth,
    writePreferredWidth,
  ]);

  useEffect(() => {
    return () => {
      cancelTween();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current);
        if (preferredWidthRef.current != null) persistNow(preferredWidthRef.current);
      }
    };
  }, [cancelTween, persistNow]);

  useEffect(() => {
    if (!isResizing) return;
    const stop = () => endDrag();
    const stopWhenHidden = () => {
      if (document.visibilityState === "hidden") endDrag();
    };
    const updateFromPointer = (event: PointerEvent) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      scheduleMove(widthFromDelta(s, event.clientX, event.clientY, aspectRatio));
    };

    window.addEventListener("blur", stop);
    window.addEventListener("pointermove", updateFromPointer, { capture: true, passive: false });
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    document.addEventListener("visibilitychange", stopWhenHidden);

    return () => {
      window.removeEventListener("blur", stop);
      window.removeEventListener("pointermove", updateFromPointer, true);
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      document.removeEventListener("visibilitychange", stopWhenHidden);
    };
  }, [aspectRatio, endDrag, isResizing, scheduleMove]);

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag();
    },
    [endDrag],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      beginDrag(event.pointerId, event.clientX, event.clientY);
    },
    [beginDrag],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const s = dragStartRef.current;
      if (!s || s.pointerId !== event.pointerId) return;
      event.preventDefault();
      scheduleMove(widthFromDelta(s, event.clientX, event.clientY, aspectRatio));
    },
    [aspectRatio, scheduleMove],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const direction =
        event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp"
            ? -1
            : 0;
      if (direction === 0) return;
      event.preventDefault();
      cancelTween();
      const step = event.shiftKey ? 80 : 24;
      const next = roundToDevicePixel(
        clampSimulatorFrameWidth(
          committedWidth + direction * step,
          defaultWidth,
          viewportWidth,
          viewportHeight,
          aspectRatio,
          reservedForChrome,
        ),
      );
      if (dragStartRef.current) {
        dragStartRef.current.currentWidth = next;
        setDragWidth(next);
      }
      writePreferredWidth(next);
      schedulePersist(next);
    },
    [
      aspectRatio,
      cancelTween,
      committedWidth,
      defaultWidth,
      schedulePersist,
      viewportHeight,
      viewportWidth,
      reservedForChrome,
      writePreferredWidth,
    ],
  );

  return {
    handleRef,
    width: isResizing || isInertia ? width : committedWidth,
    committedWidth,
    minWidth,
    maxWidth,
    isResizing,
    isInertia,
    handleHovered,
    handleActive: handleHovered || isResizing || isInertia,
    setHandleHovered,
    onPointerDown,
    onPointerMove,
    onPointerEnd,
    onKeyDown,
  };
}

function widthFromDelta(
  start: { startX: number; startY: number; startWidth: number },
  clientX: number,
  clientY: number,
  aspectRatio: number,
) {
  const dx = clientX - start.startX;
  const dy = (clientY - start.startY) * aspectRatio;
  return start.startWidth + (Math.abs(dx) >= Math.abs(dy) ? dx : dy);
}
