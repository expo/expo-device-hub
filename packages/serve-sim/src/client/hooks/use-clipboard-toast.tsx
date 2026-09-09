import { useCallback } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import { execOnHost } from "../utils/exec";
import { randomId } from "../utils/random-id";
import {
  canWriteBrowserClipboardAsync,
  copyTextViaSelection,
  readSimClipboard,
  writeTextToBrowserClipboard,
} from "../utils/sim-clipboard";

export type ClipboardToast = {
  id: string;
  status: "copied" | "manual" | "error";
  message: string;
};

const DISMISS_MS = 3000;
// The manual pill holds the only copy of the text, so it waits longer.
const MANUAL_DISMISS_MS = 12_000;

// One id for every manual pill, so a second copy replaces the first rather
// than leaving a second button bound to stale text.
const MANUAL_TOAST_ID = "sim-clipboard-manual";

function renderToast(
  status: ClipboardToast["status"],
  message: string,
  onCopy: () => void,
  id: string = randomId(),
): void {
  const toast: ClipboardToast = { id, status, message };
  sonnerToast.custom(() => <ClipboardToastContent toast={toast} onCopy={onCopy} />, {
    id,
    duration: status === "manual" ? MANUAL_DISMISS_MS : DISMISS_MS,
  });
}

export function useClipboardToast(deviceUdid: string) {
  const show = useCallback((status: ClipboardToast["status"], message: string) => {
    renderToast(status, message, () => {});
  }, []);

  const showManual = useCallback((message: string, text: string) => {
    renderToast(
      "manual",
      message,
      () => {
        const copied = copyTextViaSelection(text);
        renderToast(
          copied ? "copied" : "error",
          copied ? "Copied from simulator" : "Copy failed",
          () => {},
          MANUAL_TOAST_ID,
        );
      },
      MANUAL_TOAST_ID,
    );
  }, []);

  const copyFromSim = useCallback(async () => {
    try {
      if (canWriteBrowserClipboardAsync()) {
        const pending = readSimClipboard(deviceUdid, execOnHost);
        await writeTextToBrowserClipboard(pending);
        show("copied", (await pending) ? "Copied from simulator" : "Simulator clipboard is empty");
        return;
      }

      const text = await readSimClipboard(deviceUdid, execOnHost);
      if (!text) {
        show("copied", "Simulator clipboard is empty");
        return;
      }
      showManual("Ready — this address needs a click", text);
    } catch (error) {
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      show(
        "error",
        denied
          ? "Browser blocked the clipboard — focus this tab and retry"
          : error instanceof Error
            ? error.message
            : "Copy failed",
      );
    }
  }, [deviceUdid, show, showManual]);

  const reportPasteFailure = useCallback(() => {
    show("error", "Could not write to the simulator clipboard");
  }, [show]);

  return { copyFromSim, reportPasteFailure };
}
