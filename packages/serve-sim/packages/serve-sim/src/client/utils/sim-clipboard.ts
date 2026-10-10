import { simAuthHeaders, simEndpoint } from "./sim-endpoint";
import { encodeWsMessage } from "../../socket/send-queue";
import { EXEC_WS_MAX_MESSAGE_BYTES } from "../../socket/control-utils";

/**
 * The input-socket paste request: `[0x12][{"requestId","text"?}]`. Without text the simulator
 * pastes its own clipboard. Bound the encoded frame because JSON escaping can make it larger
 * than the text.
 */
export function encodePasteRequest(requestId: number, text?: string): Uint8Array<ArrayBuffer> | null {
  const message = encodeWsMessage(0x12, { requestId, text });
  return message.byteLength <= EXEC_WS_MAX_MESSAGE_BYTES ? message : null;
}

function pasteboardEndpoint(udid: string): string {
  const endpoint = simEndpoint("api/pasteboard");
  const separator = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${separator}device=${encodeURIComponent(udid)}`;
}

export interface SimulatorClipboardRead {
  text: string;
  cleanupWarning?: string;
}

/** A failed Copy, with any warning that the simulator may still hold a key. */
export class SimClipboardCopyError extends Error {
  readonly cleanupWarning?: string;

  constructor(message: string, cleanupWarning?: string) {
    super(message);
    this.cleanupWarning = cleanupWarning;
  }
}

/** Keep the browser's queued selection ahead of the server-side Copy request. */
export async function copySimClipboardAfterInput(
  udid: string,
  waitForPriorInput: () => Promise<void>,
  isCurrent: () => boolean,
): Promise<SimulatorClipboardRead | null> {
  await waitForPriorInput();
  if (!isCurrent()) return null;
  const response = await fetch(`${pasteboardEndpoint(udid)}&copy=1`, {
    method: "POST",
    headers: simAuthHeaders(),
  });
  // A proxy or server error can answer with a body that is not JSON; fall back to the status.
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    text?: string;
    cleanupWarning?: string;
    error?: string;
  };
  if (!response.ok || !body.ok) {
    throw new SimClipboardCopyError(
      body.error ?? `Could not read the simulator pasteboard (${response.status})`,
      body.cleanupWarning,
    );
  }
  return {
    text: body.text ?? "",
    cleanupWarning: body.cleanupWarning,
  };
}

export async function readTextFromBrowserClipboard(): Promise<string> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) throw new Error("Clipboard unavailable on this origin");
  return await clipboard.readText();
}

export async function writeTextToBrowserClipboard(text: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) throw new Error("Clipboard unavailable on this origin");
  await clipboard.writeText(text);
}
