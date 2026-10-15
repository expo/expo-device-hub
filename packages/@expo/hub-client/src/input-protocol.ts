/** Server frames on the simulator input WebSocket. */
export const WS_MSG_CONFIG = 0x82;
export const WS_MSG_INPUT_ADMITTED = 0x83;
/** Replies to the requests below: `[tag][{"requestId","ok",…}]`. */
export const WS_MSG_INPUT_BARRIER_DONE = 0x91;
export const WS_MSG_PASTE_DONE = 0x92;

/** Client requests that serve-sim answers with the same request ID. */
export const WS_MSG_INPUT_BARRIER = 0x11;
export const WS_MSG_PASTE = 0x12;
/** serve-sim closes an input socket that sends a larger frame. */
export const MAX_INPUT_FRAME_BYTES = 4 * 1024 * 1024;

/** Admission refusal when the session is unavailable or input slots are occupied. */
export const WS_REASON_INPUT_UNAVAILABLE = "Simulator input unavailable; retry after other clients disconnect";
