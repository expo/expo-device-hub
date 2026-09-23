import { useState, type PointerEvent as ReactPointerEvent } from "react";

const PILL = "bg-[#6e6e72]";
const PILL_ACTIVE = "bg-[#9a9a9e]";
const ACCENT = "rgba(255,255,255,0.28)";

function useHotEdge(onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  return {
    hot: hover || active,
    active,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        setActive(true);
        onPointerDown(e);
      },
      onPointerUp: () => setActive(false),
      onPointerCancel: () => setActive(false),
      onPointerEnter: () => setHover(true),
      onPointerLeave: () => setHover(false),
    },
  };
}

// Rendered as a fixed-positioned sibling of the panel, so the grabber can
// straddle the panel's left border without being clipped by overflow:hidden.
// The panel's own 1px border serves as the "line" — we just brighten it and
// add a centered pill on hover/drag.
export function ResizeHandle({
  panelWidth,
  visible,
  onPointerDown,
  ariaLabel,
  side = "right",
}: {
  panelWidth: number;
  visible: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  ariaLabel: string;
  side?: "left" | "right";
}) {
  const { hot, active, handlers } = useHotEdge(onPointerDown);

  // A right-edge panel sits at right:12 — its draggable (left) border is at
  // right:(12 + panelWidth - 1). The flush left sidebar sits at left:0, so its
  // draggable right border is at left:(panelWidth - 1). Center the 16px hit
  // target on whichever border is interior.
  const handleOffset = (side === "left" ? 0 : 12) + panelWidth - 9;
  const edgeClass = side === "left" ? "top-0 bottom-0" : "top-3 bottom-3";
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-hidden={!visible}
      {...handlers}
      className={`fixed ${edgeClass} w-4 z-36 cursor-col-resize touch-none transition-opacity duration-200 ${visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      style={side === "left" ? { left: handleOffset } : { right: handleOffset }}
    >
      {/* Subtle hairline accent that brightens the panel's existing border
          while the edge is hot. Tapers at top/bottom. */}
      <div
        className={`absolute top-0 bottom-0 left-1/2 w-px pointer-events-none transition-opacity duration-150 ${hot ? "opacity-100" : "opacity-0"}`}
        style={{
          transform: "translateX(-0.5px)",
          background: `linear-gradient(to bottom, transparent 0%, ${ACCENT} 30%, ${ACCENT} 70%, transparent 100%)`,
        }}
      />
      {/* Centered pill grabber, straddling the panel's left border. */}
      <div
        className={`absolute top-1/2 left-1/2 w-1 h-7 rounded-xs -translate-x-1/2 -translate-y-1/2 z-1 pointer-events-none [transition:opacity_0.15s_ease,background_0.15s_ease] ${hot ? "opacity-100" : "opacity-0"} ${active ? PILL_ACTIVE : PILL}`}
      />
    </div>
  );
}

export function ResizeEdge({
  onPointerDown,
}: {
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { hot, active, handlers } = useHotEdge(onPointerDown);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize logs drawer"
      {...handlers}
      className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none"
    >
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 h-px transition-opacity duration-150 ${hot ? "opacity-100" : "opacity-0"}`}
        style={{
          background: `linear-gradient(to right, transparent 0%, ${ACCENT} 20%, ${ACCENT} 80%, transparent 100%)`,
        }}
      />
      <div
        className={`pointer-events-none absolute left-1/2 top-0 h-1 w-7 -translate-x-1/2 rounded-xs [transition:opacity_0.15s_ease,background_0.15s_ease] ${hot ? "opacity-100" : "opacity-0"} ${active ? PILL_ACTIVE : PILL}`}
      />
    </div>
  );
}
