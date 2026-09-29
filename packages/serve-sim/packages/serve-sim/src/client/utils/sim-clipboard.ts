import { HID_USAGE_BY_CODE } from "./hid";
import { encodeWsMessage } from "../../socket/send-queue";
import { EXEC_WS_MAX_MESSAGE_BYTES } from "../../socket/control-utils";
import type { KeyEvent } from "../../text-to-keys";

function hidUsage(code: keyof typeof HID_USAGE_BY_CODE): number {
  const value = HID_USAGE_BY_CODE[code];
  if (value === undefined) throw new Error(`no HID usage for ${code}`);
  return value;
}

// Held with Command, these make the sim read another shortcut: Ctrl+V forwards Control, and
// Shift+Command+V is not paste. The shortcut lifts them and puts them back.
const LIFTED_MODIFIERS = [
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
] as const;

export function isLiftedModifier(usage: number): boolean {
  return LIFTED_MODIFIERS.some((code) => hidUsage(code) === usage);
}

function simCommandShortcutHidEvents(
  pressed: ReadonlySet<number>,
  code: "KeyV" | "KeyC",
): KeyEvent[] {
  const metaLeft = hidUsage("MetaLeft");
  const metaRight = hidUsage("MetaRight");
  const shortcutKey = hidUsage(code);
  const lifted = LIFTED_MODIFIERS.map(hidUsage).filter((usage) => pressed.has(usage));
  const events: KeyEvent[] = lifted.map((usage) => ({ type: "up", usage }));
  const commandAlreadyDown = pressed.has(metaLeft) || pressed.has(metaRight);
  if (!commandAlreadyDown) events.push({ type: "down", usage: metaLeft });
  events.push({ type: "down", usage: shortcutKey });
  events.push({ type: "up", usage: shortcutKey });
  if (!commandAlreadyDown) events.push({ type: "up", usage: metaLeft });
  for (const usage of lifted) events.push({ type: "down", usage });
  return events;
}

/** Tag of the input-socket paste request: `[0x12][{"requestId","text"}]`. */
export const SIM_PASTE_MESSAGE_TAG = 0x12;

/**
 * True when a paste request fits in one input-socket frame. The server closes the socket on a
 * larger frame instead of answering, and JSON escaping can make the frame several times the
 * size of the text, so measure the encoded request rather than the text.
 */
export function encodePasteRequest(requestId: number, text: string): Uint8Array<ArrayBuffer> | null {
  const message = encodeWsMessage(SIM_PASTE_MESSAGE_TAG, { requestId, text });
  return message.byteLength <= EXEC_WS_MAX_MESSAGE_BYTES ? message : null;
}

export function pasteRequestFits(requestId: number, text: string): boolean {
  return encodePasteRequest(requestId, text) !== null;
}

export function simPasteHidEvents(pressed: ReadonlySet<number>): KeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyV");
}

export function simCopyHidEvents(pressed: ReadonlySet<number>): KeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyC");
}

export async function readTextFromBrowserClipboard(): Promise<string> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) throw new Error("Clipboard unavailable on this origin");
  return await clipboard.readText();
}
