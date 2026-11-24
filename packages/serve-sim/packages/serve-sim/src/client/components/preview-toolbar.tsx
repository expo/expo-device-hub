import { type ReactNode } from "react";

const PANEL =
  "gap-1 p-1 bg-panel-bg border border-white/8 rounded-[10px] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)]";

// @ref LLP 0000#mobile-serve-sim-layout — one vertical toolbar overlays the device without consuming its layout space.
export function PreviewToolbar({
  keyboardRaised,
  viewportHeight,
  children,
}: {
  keyboardRaised: boolean;
  viewportHeight: number;
  children: ReactNode;
}) {
  return (
    <div
      data-panel="preview-controls"
      role="group"
      aria-label="Preview controls"
      className={`flex flex-col overflow-y-auto ${PANEL}`}
      style={{
        maxHeight: `max(0px, calc(${viewportHeight}px - env(safe-area-inset-top, 0px) - 24px))`,
      }}
      onMouseDownCapture={(event) => {
        // Keep the capture input focused without canceling touch scrolling.
        if (keyboardRaised) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}
