import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "../lib/device";

type Shot = {
  /** Object URL for the captured PNG, used by the preview and download link. */
  url: string;
  blob: Blob;
  width: number;
  height: number;
  capturedAt: number;
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** `screenshot-<serial>-<YYYYMMDD-HHMMSS>.png`, with the serial sanitized for a filename. */
function downloadName(serial: string | null, at: number): string {
  const d = new Date(at);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeSerial = (serial || "device").replace(/[^A-Za-z0-9._-]/g, "-");
  return `screenshot-${safeSerial}-${stamp}.png`;
}

/**
 * Captures a full-resolution PNG of the active device via `/api/screenshot`
 * (adb `screencap`, independent of the downscaled scrcpy stream) and offers a
 * preview, download, and copy-to-clipboard. The PNG is fetched through the
 * device-scoped `api.fetch` (so it works both standalone and under the Expo
 * DevTools plugin's path rewrite) and rendered from a blob URL.
 */
export function ScreenshotPanel() {
  const api = useApi();
  const [shot, setShot] = useState<Shot | null>(null);
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  // Mirror the latest shot so the unmount cleanup can revoke its object URL.
  const shotRef = useRef<Shot | null>(null);

  useEffect(() => {
    shotRef.current = shot;
  }, [shot]);

  const replaceShot = useCallback((next: Shot | null) => {
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return next;
    });
  }, []);

  // Drop a stale screenshot when the user switches devices.
  useEffect(() => {
    replaceShot(null);
    setStatus("Ready");
  }, [api.serial, replaceShot]);

  useEffect(() => () => {
    if (shotRef.current) URL.revokeObjectURL(shotRef.current.url);
  }, []);

  const capture = useCallback(async () => {
    setBusy(true);
    setStatus("Capturing...");
    try {
      const res = await api.fetch("/api/screenshot", { cache: "no-store" });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {}
        throw new Error(message);
      }
      const blob = await res.blob();
      let width = 0;
      let height = 0;
      try {
        const bitmap = await createImageBitmap(blob);
        width = bitmap.width;
        height = bitmap.height;
        bitmap.close();
      } catch {}
      replaceShot({ url: URL.createObjectURL(blob), blob, width, height, capturedAt: Date.now() });
      setStatus(
        width ? `${width}×${height} · ${formatBytes(blob.size)}` : `Captured · ${formatBytes(blob.size)}`,
      );
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [api, replaceShot]);

  const download = useCallback(() => {
    if (!shot) return;
    const a = document.createElement("a");
    a.href = shot.url;
    a.download = downloadName(api.serial, shot.capturedAt);
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [shot, api.serial]);

  const copy = useCallback(async () => {
    if (!shot) return;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        throw new Error("Clipboard images unsupported");
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": shot.blob })]);
      setStatus("Copied to clipboard");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  }, [shot]);

  return (
    <section className="tool-panel screenshot-panel">
      <div className="panel-heading">
        <h2>Screenshot</h2>
        <div className="location-status">{status}</div>
      </div>
      <button className="primary-action" onClick={() => void capture()} disabled={busy}>
        {busy ? "Capturing..." : "Capture"}
      </button>
      {shot ? (
        <>
          <a
            className="screenshot-preview"
            href={shot.url}
            target="_blank"
            rel="noreferrer"
            title="Open full size"
          >
            <img src={shot.url} alt="Device screenshot" />
          </a>
          <div className="panel-actions screenshot-actions">
            <button onClick={download}>Download</button>
            <button onClick={() => void copy()}>Copy</button>
          </div>
        </>
      ) : (
        <div className="screenshot-empty">No screenshot captured yet.</div>
      )}
    </section>
  );
}
