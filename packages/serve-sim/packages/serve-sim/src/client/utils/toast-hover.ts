// Touch taps synthesize mouse hover events without a matching mouseleave.
// Stop them before either Sonner or a custom toast pauses its dismiss timer.
export function installToastHoverGuard(target: EventTarget): () => void {
  let touch = false;
  const trackPointer = (event: Event) => {
    touch = (event as PointerEvent).pointerType === "touch";
  };
  const blockTouchHover = (event: Event) => {
    if (touch) event.stopPropagation();
  };
  const pointerEvents = ["pointerover", "pointerdown", "pointermove"];
  const hoverEvents = ["mouseover", "mouseenter", "mousemove"];
  for (const event of pointerEvents) target.addEventListener(event, trackPointer, true);
  for (const event of hoverEvents) target.addEventListener(event, blockTouchHover, true);
  return () => {
    for (const event of pointerEvents) target.removeEventListener(event, trackPointer, true);
    for (const event of hoverEvents) target.removeEventListener(event, blockTouchHover, true);
  };
}
