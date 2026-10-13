// Touch and pen taps can synthesize hover events without a matching mouseleave.
// Stop them before either Sonner or a custom toast pauses its dismiss timer.
export function installToastHoverGuard(target: EventTarget): () => void {
  let contact = false;
  const trackPointer = (event: Event) => {
    const pointer = event as PointerEvent;
    if (event.type === "pointerout" && pointer.pointerType !== "mouse") return;
    contact = pointer.pointerType === "touch" ||
      (pointer.pointerType === "pen" && pointer.buttons !== 0);
  };
  const blockContactHover = (event: Event) => {
    if (contact) event.stopPropagation();
  };
  const leaveWithoutHover = (event: Event) => {
    // React derives enter from mouseout's destination. Keep leave/resume, but skip enter/pause.
    if (contact) Object.defineProperties(event, {
      relatedTarget: { value: null },
      toElement: { value: null },
    });
  };
  const pointerEvents = ["pointerover", "pointerdown", "pointermove", "pointerout"];
  const hoverEvents = ["mouseover", "mouseenter", "mousemove"];
  for (const event of pointerEvents) target.addEventListener(event, trackPointer, true);
  for (const event of hoverEvents) target.addEventListener(event, blockContactHover, true);
  target.addEventListener("mouseout", leaveWithoutHover, true);
  return () => {
    for (const event of pointerEvents) target.removeEventListener(event, trackPointer, true);
    for (const event of hoverEvents) target.removeEventListener(event, blockContactHover, true);
    target.removeEventListener("mouseout", leaveWithoutHover, true);
  };
}
