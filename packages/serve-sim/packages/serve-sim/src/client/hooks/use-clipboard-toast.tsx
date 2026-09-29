import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import { createLatestClipboardWriter } from "../utils/latest-clipboard-write";
import {
  copyTextViaSelection,
  readTextFromBrowserClipboard,
  writeTextToBrowserClipboard,
  type SimulatorClipboardRead,
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
const KEY_CLEANUP_TOAST_ID = "sim-clipboard-key-cleanup";

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

export function showClipboardKeyCleanupWarning(message: string): void {
  renderToast("error", message, KEY_CLEANUP_TOAST_ID);
}

export function useClipboardToast(
  deviceUdid: string,
  readClipboardAfterInput: (isCurrent: () => boolean) => Promise<SimulatorClipboardRead | null>,
  sendTextToSim: (text: string) => Promise<{ cleanupWarning?: string }>,
) {
  const pasteGeneration = useRef(0);
  const currentDevice = useRef(deviceUdid);
  currentDevice.current = deviceUdid;
  const copyWriter = useRef<ReturnType<typeof createLatestClipboardWriter> | null>(null);
  copyWriter.current ??= createLatestClipboardWriter(writeTextToBrowserClipboard);
  const cancelPaste = useCallback(() => {
    ++pasteGeneration.current;
    sonnerToast.dismiss(PASTE_TOAST_ID);
  }, []);
  useEffect(() => () => {
    // An old read may finish after switching devices or closing the preview.
    copyWriter.current?.begin();
    cancelPaste();
    sonnerToast.dismiss(COPY_TOAST_ID);
    sonnerToast.dismiss(MANUAL_TOAST_ID);
  }, [deviceUdid, cancelPaste]);
  const copyFromSim = useCallback(async () => {
    const writer = copyWriter.current!;
    const generation = writer.begin();
    const isCurrent = () => writer.isCurrent(generation) && currentDevice.current === deviceUdid;
    sonnerToast.dismiss(MANUAL_TOAST_ID);
    renderToast("pending", "Reading simulator clipboard…", COPY_TOAST_ID);
    try {
      const result = await readClipboardAfterInput(isCurrent);
      if (!result) return;
      const { text, relaunchedApp, cleanupWarning } = result;
      if (!isCurrent()) return;
      if (cleanupWarning) showClipboardKeyCleanupWarning(cleanupWarning);
      const copiedMessage = relaunchedApp
        ? `Copied after relaunching ${relaunchedApp} to enable clipboard access`
        : "Copied from simulator";
      if (!text) {
        const emptyMessage = relaunchedApp
          ? `Clipboard is empty after relaunching ${relaunchedApp}`
          : "Simulator clipboard is empty";
        // Clear the browser clipboard too, or the next paste would insert older text.
        try {
          if (!(await writer.write(generation, "", isCurrent))) return;
          if (!isCurrent()) return;
          renderToast("copied", emptyMessage, COPY_TOAST_ID);
        } catch {
          if (!isCurrent()) return;
          renderToast("error", `${emptyMessage}. The browser clipboard still has older text`, COPY_TOAST_ID);
        }
        return;
      }

      try {
        if (!(await writer.write(generation, text, isCurrent))) return;
        if (!isCurrent()) return;
        renderToast("copied", copiedMessage, COPY_TOAST_ID);
      } catch {
        if (!isCurrent()) return;
        sonnerToast.dismiss(COPY_TOAST_ID);
        renderToast(
          "manual",
          relaunchedApp
            ? `${relaunchedApp} was relaunched. Click to copy`
            : "Ready — one click to copy",
          MANUAL_TOAST_ID,
          {
            onCopy: () => {
              if (!isCurrent()) return;
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
      if (!isCurrent()) return;
      renderToast(
        "error",
        error instanceof Error ? error.message : "Copy failed",
        COPY_TOAST_ID,
      );
    }
  }, [deviceUdid, readClipboardAfterInput]);

  const pasteTextForGeneration = useCallback(
    async (text: string, generation: number) => {
      if (generation !== pasteGeneration.current) return;
      renderToast("pending", "Pasting into the simulator…", PASTE_TOAST_ID);
      try {
        const result = await sendTextToSim(text);
        if (generation !== pasteGeneration.current) return;
        renderToast("copied", "Pasted into simulator", PASTE_TOAST_ID);
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
      renderToast("copied", "Device clipboard is empty", PASTE_TOAST_ID);
      return;
    }
    await pasteTextForGeneration(text, generation);
  }, [pasteText, pasteTextForGeneration]);

  return useMemo(
    () => ({ copyFromSim, pasteFromDevice, pasteText, cancelPaste }),
    [copyFromSim, pasteFromDevice, pasteText, cancelPaste],
  );
}
