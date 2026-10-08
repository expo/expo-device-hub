import { type DeviceClient } from "./types";

/** A failed Paste or Copy, with serve-sim's warning when a key can still be held on the device. */
export class ClipboardActionError extends Error {
  readonly cleanupWarning?: string;

  constructor(message: string, cleanupWarning?: string) {
    super(message);
    this.name = "ClipboardActionError";
    this.cleanupWarning = cleanupWarning;
  }
}

const unavailable = () => Promise.reject(new Error("This device has no clipboard support."));

/** Clipboard fields of a client whose backend has none, with stable identities across renders. */
export const NO_CLIPBOARD = {
  pasteText: unavailable,
  copyText: unavailable,
  clipboardActionId: 0,
  clipboardPending: null,
  clipboardError: null,
  clipboardWarning: null,
} satisfies Pick<
  DeviceClient,
  | "pasteText"
  | "copyText"
  | "clipboardActionId"
  | "clipboardPending"
  | "clipboardError"
  | "clipboardWarning"
>;
