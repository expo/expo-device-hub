export function onDrawerEscape(target: EventTarget, handle: () => void): () => void {
  const listener = (event: Event): void => {
    if ((event as KeyboardEvent).key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handle();
  };
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}
