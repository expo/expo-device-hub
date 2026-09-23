import { useCallback, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { ScreenshotToast } from "../components/screenshot-toast";
import { runHostAction } from "../utils/exec";
import {
  fetchScreenshotPng,
  isLoopbackPreviewHostname,
  triggerBrowserDownload,
} from "../utils/screenshot-capture";

export type ScreenshotToast = {
  id: string;
  status: "saving" | "saved" | "error";
  // "in" while the pill is showing, "out" once the dismiss timer fires — the
  // component plays the exit animation, then calls dismiss() to unmount.
  phase: "in" | "out";
  // Absolute path of the staged copy on the host once the capture lands; used by
  // the drag-and-drop file URL.
  path?: string;
  // Name of the capture. "Open in Finder" reveals the Desktop copy by this name, unless the host
  // kept only the staged file (see revealParams).
  fileName?: string;
  // The host kept the capture at `path` and made no Desktop copy; `message` says why.
  stagedOnly?: boolean;
  // Tunneled/LAN previews download into the browser instead of exposing a path
  // on the remote simulator host. Kept alive while the toast is mounted so the
  // thumbnail and "Download again" action can reuse it.
  downloadUrl?: string;
  downloadName?: string;
  // data: URL of a downscaled preview, filled in best-effort after the save.
  thumb?: string;
  message?: string;
};

// How long the success pill lingers before auto-dismissing. Hovering pauses
// the timer, so this only needs to be long enough to notice the pill — not to
// read and act on it.
const SAVED_DISMISS_MS = 3500;
// A staged-only pill is the only place the host's sentence about the missing Desktop copy appears:
// about forty words plus a path, so the reader has to be able to finish it.
const STAGED_ONLY_DISMISS_MS = 12_000;
const ERROR_DISMISS_MS = 4000;
const CAPTURE_TIMEOUT_MS = 10_000;

function savedDismissMs(toast: ScreenshotToast): number {
  return toast.stagedOnly ? STAGED_ONLY_DISMISS_MS : SAVED_DISMISS_MS;
}

export function revealParams(
  toast: ScreenshotToast,
): { screenshot: string } | { path: string } | null {
  if (toast.stagedOnly && toast.path) return { path: toast.path };
  if (toast.fileName) return { screenshot: toast.fileName };
  return null;
}

function timestampSlug(): string {
  // 2026-06-11T14-12-44-123 — filesystem-safe, sorts chronologically. Keep the
  // milliseconds so two captures in the same second don't clobber one file.
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
}

export function useScreenshotToast(deviceUdid?: string | null) {
  const toastRef = useRef<ScreenshotToast | null>(null);
  const toastIdRef = useRef<string | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDismissMsRef = useRef<number | null>(null);
  const captureInFlightRef = useRef(false);

  const clearDismissTimer = useCallback(() => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = null;
    dismissDeadlineRef.current = null;
  }, []);

  const dismiss = useCallback((id?: string | number) => {
    const targetId = id ?? toastIdRef.current ?? undefined;
    clearDismissTimer();
    remainingDismissMsRef.current = null;
    sonnerToast.dismiss(targetId);
    if (targetId === undefined || toastIdRef.current === String(targetId)) {
      const downloadUrl = toastRef.current?.downloadUrl;
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      toastRef.current = null;
      toastIdRef.current = null;
    }
  }, [clearDismissTimer]);

  const reveal = useCallback(() => {
    const t = toastRef.current;
    if (!t) return;
    const params = revealParams(t);
    if (params) void runHostAction("reveal", params);
    else if (t.downloadUrl && t.downloadName) {
      triggerBrowserDownload(t.downloadUrl, t.downloadName);
    }
  }, []);

  const scheduleDismiss = useCallback((ms: number) => {
    clearDismissTimer();
    const delay = Math.max(0, ms);
    const id = toastIdRef.current;
    remainingDismissMsRef.current = delay;
    dismissDeadlineRef.current = Date.now() + delay;
    dismissTimerRef.current = setTimeout(() => dismiss(id ?? undefined), delay);
  }, [clearDismissTimer, dismiss]);

  const pauseDismiss = useCallback(() => {
    if (!dismissTimerRef.current || dismissDeadlineRef.current == null) return;
    remainingDismissMsRef.current = Math.max(0, dismissDeadlineRef.current - Date.now());
    clearDismissTimer();
  }, [clearDismissTimer]);

  const resumeDismiss = useCallback(() => {
    const remaining = remainingDismissMsRef.current;
    if (remaining == null) return;
    scheduleDismiss(remaining);
  }, [scheduleDismiss]);

  const render = useCallback((next: ScreenshotToast, duration = Infinity) => {
    toastRef.current = next;
    toastIdRef.current = next.id;
    sonnerToast.custom(
      (id) => (
        <ScreenshotToast
          toast={next}
          onReveal={reveal}
          onDismiss={() => dismiss(id)}
          onPause={pauseDismiss}
          onResume={resumeDismiss}
        />
      ),
      { id: next.id, duration: Infinity },
    );
    if (Number.isFinite(duration)) scheduleDismiss(duration);
    else {
      clearDismissTimer();
      remainingDismissMsRef.current = null;
    }
  }, [clearDismissTimer, dismiss, pauseDismiss, resumeDismiss, reveal, scheduleDismiss]);

  const capture = useCallback(async () => {
    if (!deviceUdid || captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    const id = crypto.randomUUID();
    render({ id, status: "saving", phase: "in" });

    const fileName = `serve-sim-screenshot-${timestampSlug()}.png`;
    const captureController = new AbortController();
    const captureTimer = setTimeout(() => {
      captureController.abort(new Error("Screenshot timed out"));
    }, CAPTURE_TIMEOUT_MS);

    try {
      if (!isLoopbackPreviewHostname(window.location.hostname)) {
        const png = await fetchScreenshotPng(deviceUdid, {
          signal: captureController.signal,
        });
        const downloadUrl = URL.createObjectURL(png);
        triggerBrowserDownload(downloadUrl, fileName);
        render({
          id,
          status: "saved",
          phase: "in",
          downloadUrl,
          downloadName: fileName,
          thumb: downloadUrl,
        }, SAVED_DISMISS_MS);
        return;
      }

      // The host hands back the staged path, which the drag-and-drop URL needs; the Desktop copy
      // is the host's own last step.
      const res = await runHostAction(
        "screenshot.capture",
        { udid: deviceUdid, fileName },
        { signal: captureController.signal },
      );
      const path = res.stdout.trim();
      if (res.exitCode !== 0 || !path) {
        render({ id, status: "error", phase: "in", message: res.stderr.trim() || "Screenshot failed" }, ERROR_DISMISS_MS);
        return;
      }

      const message = res.stderr.trim();
      const saved: ScreenshotToast = message
        ? { id, status: "saved", phase: "in", path, fileName, stagedOnly: true, message }
        : { id, status: "saved", phase: "in", path, fileName };
      render(saved, savedDismissMs(saved));

      // Best-effort thumbnail: the host downscales, encodes and cleans up. Failures (sips
      // missing, etc.) just leave the placeholder.
      try {
        const tr = await runHostAction(
          "screenshot.thumbnail",
          { fileName },
          { signal: captureController.signal },
        );
        const b64 = tr.stdout.replace(/\s+/g, "");
        if (b64) {
          const current = toastRef.current;
          if (current?.id === id) {
            render({ ...current, thumb: `data:image/png;base64,${b64}` }, savedDismissMs(current));
          }
        }
      } catch {
        // ignore — the pill is fully functional without a preview.
      }
    } catch (e) {
      render({
        id,
        status: "error",
        phase: "in",
        message: e instanceof Error ? e.message : "Screenshot failed",
      }, ERROR_DISMISS_MS);
    } finally {
      clearTimeout(captureTimer);
      captureInFlightRef.current = false;
    }
  }, [deviceUdid, render]);

  return { capture, reveal, dismiss };
}
