// Touch and pen taps can synthesize hover events without a matching mouseleave.
// Stop them before either Sonner or a custom toast pauses its dismiss timer.
// This relies on Preact's native mouseenter; React dev can still derive enter from mouseout.
export function installToastHoverGuard(target: EventTarget): () => void {
  let contact = false;
  const trackPointer = (event: Event) => {
    const pointer = event as PointerEvent;
    contact = pointer.pointerType === "touch" ||
      (pointer.pointerType === "pen" && pointer.buttons !== 0);
  };
  const blockContactHover = (event: Event) => {
    if (contact) event.stopPropagation();
  };
  const pointerEvents = ["pointerover", "pointerdown", "pointermove"];
  const hoverEvents = ["mouseover", "mouseenter", "mousemove"];
  for (const event of pointerEvents) target.addEventListener(event, trackPointer, true);
  for (const event of hoverEvents) target.addEventListener(event, blockContactHover, true);
  return () => {
    for (const event of pointerEvents) target.removeEventListener(event, trackPointer, true);
    for (const event of hoverEvents) target.removeEventListener(event, blockContactHover, true);
  };
}
