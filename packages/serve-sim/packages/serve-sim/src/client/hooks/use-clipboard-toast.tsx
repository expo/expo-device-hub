import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import { readTextFromBrowserClipboard } from "../utils/sim-clipboard";

export type ClipboardToast = {
  status: "pending" | "copied" | "paste" | "error";
  message: string;
};

const PASTE_TOAST_ID = "sim-clipboard-paste";
const KEY_CLEANUP_TOAST_ID = "sim-clipboard-key-cleanup";

export function showClipboardKeyCleanupWarning(message: string): void {
  renderToast("error", message, undefined, KEY_CLEANUP_TOAST_ID);
}

function renderToast(status: ClipboardToast["status"], message: string, onPaste?: (text: string) => void, id = PASTE_TOAST_ID): void {
  const toast: ClipboardToast = { status, message };
  sonnerToast.custom(
    () => <ClipboardToastContent toast={toast} onPaste={onPaste} />,
    { id, duration: status === "pending" || status === "paste" ? Infinity : 3000 },
  );
}

export function useClipboardToast(sendTextToSim: (text: string) => Promise<{ cleanupWarning?: string }>) {
  const pasteGeneration = useRef(0);
  const cancelPaste = useCallback(() => {
    ++pasteGeneration.current;
    sonnerToast.dismiss(PASTE_TOAST_ID);
  }, []);
  useEffect(() => cancelPaste, [cancelPaste]);
  const pasteTextForGeneration = useCallback(async (text: string, generation: number) => {
    if (generation !== pasteGeneration.current) return;
    renderToast("pending", "Pasting into the simulator…");
    try {
      const result = await sendTextToSim(text);
      if (generation !== pasteGeneration.current) return;
      renderToast("copied", "Pasted into simulator");
      if (result.cleanupWarning) showClipboardKeyCleanupWarning(result.cleanupWarning);
    } catch (error) {
      if (generation !== pasteGeneration.current) return;
      renderToast("error", error instanceof Error ? error.message : "Could not write to the simulator clipboard");
    }
  }, [sendTextToSim]);

  const pasteText = useCallback((text: string) => {
    return pasteTextForGeneration(text, ++pasteGeneration.current);
  }, [pasteTextForGeneration]);

  const pasteFromDevice = useCallback(async () => {
    const generation = ++pasteGeneration.current;
    let text: string;
    try {
      text = await readTextFromBrowserClipboard();
    } catch {
      if (generation !== pasteGeneration.current) return;
      renderToast("paste", "Paste here to send it to the simulator", (pasted) => {
        if (generation === pasteGeneration.current) void pasteText(pasted);
      });
      return;
    }
    if (generation !== pasteGeneration.current) return;
    if (!text) {
      renderToast("copied", "Device clipboard is empty");
      return;
    }
    await pasteTextForGeneration(text, generation);
  }, [pasteText, pasteTextForGeneration]);

  return useMemo(() => ({ pasteFromDevice, pasteText, cancelPaste }), [pasteFromDevice, pasteText, cancelPaste]);
}
