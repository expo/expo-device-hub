/** Validate before opening a device session or allocating a panel capture. */
export function validatePanelRoute(screenId: string | number, endpoint: string, method: string | undefined):
  { screenId: 1 | 3 } | { status: 400 | 404 | 405; error: string } {
  const panelId = screenId === 1 || screenId === "1" ? 1 : screenId === 3 || screenId === "3" ? 3 : null;
  if (panelId === null) return { status: 400, error: "invalid_panel" };
  if (!["stream.mjpeg", "stream.avcc", "webrtc/offer", "webrtc/close", "webrtc/stats"].includes(endpoint)) {
    return { status: 404, error: "unknown_panel_endpoint" };
  }
  const expectedMethod = endpoint === "webrtc/offer" || endpoint === "webrtc/close" ? "POST" : "GET";
  if (method !== "OPTIONS" && method !== expectedMethod) return { status: 405, error: "method_not_allowed" };
  return { screenId: panelId };
}
