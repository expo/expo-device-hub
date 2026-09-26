import { HID_USAGE_BY_CODE } from "./hid";
import { simEndpoint } from "./sim-endpoint";
import { encodeWsMessage } from "./ws-send-queue";
import { EXEC_WS_MAX_MESSAGE_BYTES } from "../../exec-ws-utils";
import type { KeyEvent } from "../../text-to-keys";

export type { KeyEvent as HidKeyEvent } from "../../text-to-keys";

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
  code: "KeyV" | "KeyC" | "KeyA",
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
export function pasteRequestFits(requestId: number, text: string): boolean {
  return encodeWsMessage(SIM_PASTE_MESSAGE_TAG, { requestId, text }).byteLength <= EXEC_WS_MAX_MESSAGE_BYTES;
}

export function simPasteHidEvents(pressed: ReadonlySet<number>): KeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyV");
}

export function simCopyHidEvents(pressed: ReadonlySet<number>): KeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyC");
}

export function simSelectAllHidEvents(pressed: ReadonlySet<number>): KeyEvent[] {
  return simCommandShortcutHidEvents(pressed, "KeyA");
}

function pasteboardEndpoint(udid: string): string {
  const endpoint = simEndpoint("api/pasteboard");
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}device=${encodeURIComponent(udid)}`;
}

function pasteboardHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${window.__SIM_PREVIEW__?.execToken ?? ""}`,
  };
}

export async function copyTextToSim(udid: string, text: string): Promise<boolean> {
  const response = await fetch(pasteboardEndpoint(udid), {
    method: "PUT",
    headers: {
      ...pasteboardHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });
  const body = (await response.json()) as { ok?: boolean };
  return response.ok && body.ok === true;
}

export interface SimulatorClipboardRead {
  text: string;
  relaunchedApp: string | null;
}

/**
 * Read the simulator pasteboard. With `copy`, the server first presses Command+C and reads under
 * the same lock, so another viewer's copy or paste cannot change the text in between.
 */
export async function readSimClipboard(
  udid: string,
  { copy = false }: { copy?: boolean } = {},
): Promise<SimulatorClipboardRead> {
  const response = await fetch(`${pasteboardEndpoint(udid)}${copy ? "&copy=1" : ""}`, {
    method: "POST",
    headers: pasteboardHeaders(),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    text?: string;
    relaunchedApp?: string | null;
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new Error(body.error ?? `Could not read the simulator pasteboard (${response.status})`);
  }
  return {
    text: body.text ?? "",
    relaunchedApp: body.relaunchedApp ?? null,
  };
}

export function copyTextViaSelection(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
  }
}

export async function readTextFromBrowserClipboard(): Promise<string> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) throw new Error("Clipboard unavailable on this origin");
  return await clipboard.readText();
}

export async function writeTextToBrowserClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("Clipboard unavailable on this origin");

  if (typeof ClipboardItem !== "undefined" && clipboard.write) {
    const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) });
    await clipboard.write([item]);
    return;
  }

  if (!clipboard.writeText) throw new Error("Clipboard unavailable on this origin");
  await clipboard.writeText(text);
}
