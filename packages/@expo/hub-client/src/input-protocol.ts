/** Server frames on the simulator input WebSocket. */
export const WS_MSG_CONFIG = 0x82;
export const WS_MSG_INPUT_ADMITTED = 0x83;

/** Admission refusal when the session is unavailable or input slots are occupied. */
export const WS_REASON_INPUT_UNAVAILABLE = "Simulator input unavailable; retry after other clients disconnect";
