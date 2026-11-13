/**
 * A failure that describes only what the caller sent, such as a refused value, so its message
 * may go back to a remote caller. Anything else can carry host paths and stays on the host.
 */
export class UiInputError extends Error {}
