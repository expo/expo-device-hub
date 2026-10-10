import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import { readTextFromBrowserClipboard } from "../utils/sim-clipboard";

export type ClipboardToast = {
  status: "pending" | "success" | "paste" | "error";
  message: string;
};

const DISMISS_MS = 3000;

const PASTE_TOAST_ID = "sim-clipboard-paste";
const KEY_CLEANUP_TOAST_ID = "sim-clipboard-key-cleanup";

function renderToast(
  status: ClipboardToast["status"],
  message: string,
  id: string,
  actions: { onPaste?: (text: string) => void } = {},
): void {
  const toast: ClipboardToast = { status, message };
  sonnerToast.custom(
    () => <ClipboardToastContent toast={toast} onPaste={actions.onPaste} />,
    {
      id,
      duration: status === "pending" || status === "paste" ? Infinity : DISMISS_MS,
    },
  );
}

export function showClipboardKeyCleanupWarning(message: string): void {
  renderToast("error", message, KEY_CLEANUP_TOAST_ID);
}

export function useClipboardToast(sendTextToSim: (text: string) => Promise<{ cleanupWarning?: string }>) {
  // @ref LLP 0010#paste — the latest Paste action wins over one still reading the clipboard
  const pasteGeneration = useRef(0);
  const cancelPaste = useCallback(() => {
    ++pasteGeneration.current;
    sonnerToast.dismiss(PASTE_TOAST_ID);
  }, []);
  useEffect(() => cancelPaste, [cancelPaste]);

  const pasteTextForGeneration = useCallback(
    async (text: string, generation: number) => {
      if (generation !== pasteGeneration.current) return;
      renderToast("pending", "Pasting into the simulator…", PASTE_TOAST_ID);
      try {
        const result = await sendTextToSim(text);
        if (generation !== pasteGeneration.current) return;
        renderToast("success", "Pasted into simulator", PASTE_TOAST_ID);
        if (result.cleanupWarning) showClipboardKeyCleanupWarning(result.cleanupWarning);
      } catch (error) {
        if (generation !== pasteGeneration.current) return;
        renderToast(
          "error",
          error instanceof Error ? error.message : "Could not write to the simulator clipboard",
          PASTE_TOAST_ID,
        );
      }
    },
    [sendTextToSim],
  );

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
      renderToast("paste", "Paste here to send it to the simulator", PASTE_TOAST_ID, {
        onPaste: (pasted) => {
          if (generation === pasteGeneration.current) void pasteText(pasted);
        },
      });
      return;
    }
    if (generation !== pasteGeneration.current) return;
    if (!text) {
      renderToast("success", "Device clipboard is empty", PASTE_TOAST_ID);
      return;
    }
    await pasteTextForGeneration(text, generation);
  }, [pasteText, pasteTextForGeneration]);

  return useMemo(
    () => ({ pasteFromDevice, pasteText, cancelPaste }),
    [pasteFromDevice, pasteText, cancelPaste],
  );
}
