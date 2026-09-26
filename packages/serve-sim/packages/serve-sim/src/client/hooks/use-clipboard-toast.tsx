import { useCallback, useEffect, useMemo } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import { framePolicyBlocks, requestFramePermission, takeFramePermissionGrant } from "../utils/frame-permission";
import {
  copyTextViaSelection,
  readSimClipboard,
  readTextFromBrowserClipboard,
  writeTextToBrowserClipboard,
} from "../utils/sim-clipboard";

export type ClipboardToast = {
  status: "pending" | "copied" | "manual" | "paste" | "error";
  message: string;
};

const DISMISS_MS = 3000;
const MANUAL_DISMISS_MS = 12_000;

const MANUAL_TOAST_ID = "sim-clipboard-manual";
const COPY_TOAST_ID = "sim-clipboard-copy";
const PASTE_TOAST_ID = "sim-clipboard-paste";

function renderToast(
  status: ClipboardToast["status"],
  message: string,
  id: string,
  actions: { onCopy?: () => void; onPaste?: (text: string) => void } = {},
): void {
  const toast: ClipboardToast = { status, message };
  sonnerToast.custom(
    () => <ClipboardToastContent toast={toast} onCopy={actions.onCopy} onPaste={actions.onPaste} />,
    {
      id,
      duration:
        status === "pending" || status === "paste"
          ? Infinity
          : status === "manual"
            ? MANUAL_DISMISS_MS
            : DISMISS_MS,
    },
  );
}

export function useClipboardToast(
  deviceUdid: string,
  waitForPriorInput: () => Promise<void>,
  sendTextToSim: (text: string) => Promise<boolean>,
) {
  const copyFromSim = useCallback(async () => {
    renderToast("pending", "Reading simulator clipboard…", COPY_TOAST_ID);
    try {
      await waitForPriorInput();
      const { text, relaunchedApp } = await readSimClipboard(deviceUdid, { copy: true });
      const copiedMessage = relaunchedApp
        ? `Copied after relaunching ${relaunchedApp} to enable clipboard access`
        : "Copied from simulator";
      if (!text) {
        renderToast(
          "copied",
          relaunchedApp
            ? `Clipboard is empty after relaunching ${relaunchedApp}`
            : "Simulator clipboard is empty",
          COPY_TOAST_ID,
        );
        return;
      }

      try {
        await writeTextToBrowserClipboard(text);
        renderToast("copied", copiedMessage, COPY_TOAST_ID);
      } catch {
        sonnerToast.dismiss(COPY_TOAST_ID);
        renderToast(
          "manual",
          relaunchedApp
            ? `${relaunchedApp} was relaunched. Click to copy`
            : "Ready — one click to copy",
          MANUAL_TOAST_ID,
          {
            onCopy: () => {
              const copied = copyTextViaSelection(text);
              renderToast(
                copied ? "copied" : "error",
                copied ? "Copied from simulator" : "Copy failed",
                MANUAL_TOAST_ID,
              );
            },
          },
        );
      }
    } catch (error) {
      renderToast(
        "error",
        error instanceof Error ? error.message : "Copy failed",
        COPY_TOAST_ID,
      );
    }
  }, [deviceUdid, waitForPriorInput]);

  const pasteText = useCallback(
    async (text: string) => {
      renderToast("pending", "Pasting into the simulator…", PASTE_TOAST_ID);
      try {
        const ok = await sendTextToSim(text);
        renderToast(
          ok ? "copied" : "error",
          ok ? "Pasted into simulator" : "Could not write to the simulator clipboard",
          PASTE_TOAST_ID,
        );
      } catch (error) {
        renderToast(
          "error",
          error instanceof Error ? error.message : "Could not write to the simulator clipboard",
          PASTE_TOAST_ID,
        );
      }
    },
    [sendTextToSim],
  );

  useEffect(() => {
    // The toaster mounts after this component, so it cannot show a toast raised during mount.
    const timer = setTimeout(() => {
      if (takeFramePermissionGrant("clipboard-read")) {
        renderToast("copied", "Clipboard allowed. Paste again", PASTE_TOAST_ID);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const pasteFromDevice = useCallback(async () => {
    let text: string;
    try {
      text = await readTextFromBrowserClipboard();
    } catch {
      if (framePolicyBlocks("clipboard-read")) requestFramePermission("clipboard-read");
      renderToast("paste", "Paste here to send it to the simulator", PASTE_TOAST_ID, {
        onPaste: (pasted) => void pasteText(pasted),
      });
      return;
    }
    if (!text) {
      renderToast("copied", "Device clipboard is empty", PASTE_TOAST_ID);
      return;
    }
    await pasteText(text);
  }, [pasteText]);

  return useMemo(
    () => ({ copyFromSim, pasteFromDevice, pasteText }),
    [copyFromSim, pasteFromDevice, pasteText],
  );
}
