/** Cancel browser-owned input when it can no longer receive matching release events. */
export function listenForInputCancellation(cancel: () => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const onVisibilityChange = () => {
    if (document.hidden) cancel();
  };
  window.addEventListener("blur", cancel);
  window.addEventListener("pagehide", cancel);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("blur", cancel);
    window.removeEventListener("pagehide", cancel);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
