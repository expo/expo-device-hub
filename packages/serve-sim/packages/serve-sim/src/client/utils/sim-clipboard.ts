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

export async function readTextFromBrowserClipboard(): Promise<string> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) throw new Error("Clipboard unavailable on this origin");
  return await clipboard.readText();
}
