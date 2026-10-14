import { useCallback, useEffect, useMemo, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ClipboardToastContent } from "../components/app-toasts";
import {
  browserMayAllow,
  requestFramePermission,
  shouldAskFrameForClipboardRead,
  takeFramePermissionGrant,
} from "../utils/frame-permission";
import { createLatestClipboardWriter } from "../utils/latest-clipboard-write";
import { copyTextViaSelection } from "../utils/share-link";
import {
  readTextFromBrowserClipboard,
  SimClipboardCopyError,
  writeTextToBrowserClipboard,
  type SimulatorClipboardRead,
} from "../utils/sim-clipboard";

export type ClipboardToast = {
  status: "pending" | "success" | "manual" | "paste" | "info" | "error";
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
  // @ref LLP 0010#paste — the latest Paste action wins over one still reading the clipboard
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
      const { text, cleanupWarning } = result;
      if (!isCurrent()) return;
      if (cleanupWarning) showClipboardKeyCleanupWarning(cleanupWarning);
      try {
        if (!(await writer.write(generation, text, isCurrent))) return;
        if (!isCurrent()) return;
        renderToast("success", text ? "Copied from simulator" : "Simulator clipboard is empty", COPY_TOAST_ID);
      } catch {
        if (!isCurrent()) return;
        if (!text) {
          renderToast("error", "Simulator clipboard is empty. The browser clipboard still has older text", COPY_TOAST_ID);
          return;
        }
        sonnerToast.dismiss(COPY_TOAST_ID);
        renderToast("manual", "Ready — one click to copy", MANUAL_TOAST_ID, {
          onCopy: () => {
            if (!isCurrent()) return;
            const copied = copyTextViaSelection(text);
            renderToast(
              copied ? "success" : "error",
              copied ? "Copied from simulator" : "Copy failed",
              MANUAL_TOAST_ID,
            );
          },
        });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof SimClipboardCopyError && error.cleanupWarning) {
        showClipboardKeyCleanupWarning(error.cleanupWarning);
      }
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

  useEffect(() => {
    // The toaster mounts after this component, so it cannot show a toast raised during mount.
    const timer = setTimeout(() => {
      const grant = takeFramePermissionGrant("clipboard-read");
      if (!grant) return;
      // A Paste, device change, or unmount during the check owns the toast from then on.
      const generation = pasteGeneration.current;
      void browserMayAllow("clipboard-read").then((allowed) => {
        if (!allowed || generation !== pasteGeneration.current) return;
        if (grant === "allowed") renderToast("success", "Clipboard allowed. Paste again", PASTE_TOAST_ID);
        else renderToast("info", "Paste again", PASTE_TOAST_ID);
      });
    }, 0);
    return () => clearTimeout(timer);
  }, []);

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
      if (shouldAskFrameForClipboardRead()) requestFramePermission("clipboard-read");
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
    () => ({ copyFromSim, pasteFromDevice, pasteText, cancelPaste }),
    [copyFromSim, pasteFromDevice, pasteText, cancelPaste],
  );
}
