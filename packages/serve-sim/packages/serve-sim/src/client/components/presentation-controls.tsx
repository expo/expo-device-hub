import { GripVertical, Minimize2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { IconButton } from "./icon-button";
import { PRESENTATION_EXIT_WRAPPER_PADDING } from "../utils/presentation";

const GRIP_WIDTH = 20;
const MARGIN = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function clampToViewport(x: number, y: number, w: number, h: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const minVisible = GRIP_WIDTH + PRESENTATION_EXIT_WRAPPER_PADDING;
  return {
    x: clamp(x, 0, vw - minVisible),
    y: clamp(y, MARGIN, vh - h),
  };
}

export function PresentationControls({ onExit, children }: { onExit: () => void; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    setPos({ x: window.innerWidth - w - MARGIN, y: MARGIN });
  }, []);

  useEffect(() => {
    const onResize = () => {
      const el = ref.current;
      if (!el || dragRef.current) return;
      setPos((p) => p && clampToViewport(p.x, p.y, el.offsetWidth, el.offsetHeight));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    dragRef.current = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    e.stopPropagation();
    const el = ref.current;
    const w = el ? el.offsetWidth : 80;
    const h = el ? el.offsetHeight : 38;
    const raw = { x: e.clientX - drag.offsetX, y: e.clientY - drag.offsetY };
    setPos(clampToViewport(raw.x, raw.y, w, h));
  }, []);

  const finishDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    finishDrag();
  }, [finishDrag]);

  const onLostCapture = useCallback(() => {
    finishDrag();
  }, [finishDrag]);

  return (
    <div
      ref={ref}
      className="z-50 flex items-center gap-0.5 rounded-[10px] bg-panel-bg border border-white/8 backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)]"
      style={{
        position: "fixed",
        left: pos?.x ?? 0,
        top: pos?.y ?? MARGIN,
        padding: PRESENTATION_EXIT_WRAPPER_PADDING,
        visibility: pos ? "visible" : "hidden",
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={onLostCapture}
    >
      <div
        className="h-9 sm:h-[30px] flex items-center justify-center cursor-grab active:cursor-grabbing text-[#8e8e93] hover:text-white/70 select-none touch-none"
        style={{ width: GRIP_WIDTH }}
        onPointerDown={onPointerDown}
        aria-label="Drag to reposition"
        title="Drag to reposition"
      >
        <GripVertical size={14} strokeWidth={1.5} />
      </div>
      {children}
      <IconButton
        onClick={onExit}
        aria-label="Exit full screen"
        title="Exit full screen (Esc)"
      >
        <Minimize2 size={18} strokeWidth={1.75} />
      </IconButton>
    </div>
  );
}
