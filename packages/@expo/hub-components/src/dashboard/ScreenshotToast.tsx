import { useCallback, useEffect, useRef, useState } from 'react';

import { type DeviceClient, type ScreenshotArtifact } from '@expo/hub-client';
import { bg, border, ChevronRightIcon, isFocusVisible, radius, shadow, text, textSize } from '../primitives';

export type ScreenshotToastState =
  | { phase: 'capturing'; id: number }
  | { phase: 'saved'; id: number; url: string; filename: string; artifact: ScreenshotArtifact | null }
  | { phase: 'capture-failed'; id: number };

const SAVED_DISMISS_MS = 3500;
// The failure reason appears only here, so the reader needs time to finish it.
const WARNING_DISMISS_MS = 12_000;
const FAILED_DISMISS_MS = 4000;

/** The session artifact line under a saved toast, and how long the toast stays. */
export function artifactNotice(artifact: ScreenshotArtifact | null): { message?: string; dismissMs: number } {
  if (artifact?.status === 'saved') {
    return { message: 'Saved to session artifacts', dismissMs: SAVED_DISMISS_MS };
  }
  if (artifact?.status === 'failed') {
    return {
      message: `Downloaded. Not saved to session artifacts${artifact.error ? `: ${artifact.error}` : ''}`,
      dismissMs: WARNING_DISMISS_MS,
    };
  }
  return { dismissMs: SAVED_DISMISS_MS };
}

/** Filesystem-safe screenshot name, e.g. `iPhone-16-2026-06-30T12-34-56.png`. */
function screenshotFilename(name: string): string {
  const slug = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'device';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  return `${slug}-${stamp}.png`;
}

function download(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Captures a screenshot, downloads it, and drives the toast that reports it. The toast keeps the
 * PNG's object URL alive for its thumbnail and "Download again" until it goes away.
 */
export function useScreenshotToast(client: DeviceClient, deviceName: string) {
  const [toast, setToast] = useState<ScreenshotToastState | null>(null);
  const current = useRef<ScreenshotToastState | null>(null);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef<number | null>(null);
  const remaining = useRef<number | null>(null);

  const show = useCallback((next: ScreenshotToastState | null) => {
    const prev = current.current;
    if (prev?.phase === 'saved') URL.revokeObjectURL(prev.url);
    current.current = next;
    setToast(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    deadline.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    remaining.current = null;
    show(null);
  }, [clearTimer, show]);

  const schedule = useCallback(
    (ms: number) => {
      clearTimer();
      remaining.current = ms;
      deadline.current = Date.now() + ms;
      timer.current = setTimeout(dismiss, ms);
    },
    [clearTimer, dismiss],
  );

  const pause = useCallback(() => {
    if (!timer.current || deadline.current == null) return;
    remaining.current = Math.max(0, deadline.current - Date.now());
    clearTimer();
  }, [clearTimer]);

  const resume = useCallback(() => {
    if (remaining.current != null) schedule(remaining.current);
  }, [schedule]);

  useEffect(
    () => () => {
      seq.current++;
      clearTimer();
      if (current.current?.phase === 'saved') URL.revokeObjectURL(current.current.url);
      current.current = null;
    },
    [clearTimer],
  );

  const capture = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++seq.current;
    clearTimer();
    remaining.current = null;
    show({ phase: 'capturing', id });
    try {
      const shot = await client.screenshot();
      if (seq.current !== id) return;
      if (!shot) {
        show({ phase: 'capture-failed', id });
        schedule(FAILED_DISMISS_MS);
        return;
      }
      const url = URL.createObjectURL(shot.blob);
      const filename = screenshotFilename(deviceName);
      download(url, filename);
      show({ phase: 'saved', id, url, filename, artifact: shot.artifact });
      schedule(artifactNotice(shot.artifact).dismissMs);
    } finally {
      inFlight.current = false;
    }
  }, [client, deviceName, clearTimer, schedule, show]);

  const downloadAgain = useCallback(() => {
    const t = current.current;
    if (t?.phase === 'saved') download(t.url, t.filename);
  }, []);

  return { toast, capture, downloadAgain, dismiss, pause, resume };
}

const PILL_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: 320,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '8px 14px 8px 8px',
  backgroundColor: bg.default,
  border: `1px solid ${border.default}`,
  borderRadius: radius.lg,
  boxShadow: shadow.lg,
  color: text.default,
  fontFamily: 'inherit',
  textAlign: 'left',
} as const;

/**
 * The pill that reports a screenshot: a thumbnail, the capture state, and for a saved capture a
 * "Download again" action and the session artifact outcome. Hovering it holds it on screen.
 */
export function ScreenshotToast({
  toast,
  onDownloadAgain,
  onPause,
  onResume,
}: {
  toast: ScreenshotToastState | null;
  onDownloadAgain: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  if (!toast) return null;

  const title =
    toast.phase === 'capturing'
      ? 'Capturing screenshot…'
      : toast.phase === 'saved'
        ? 'Screenshot saved'
        : 'Screenshot failed';
  const body = (
    <>
      <span
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          display: 'block',
          overflow: 'hidden',
          borderRadius: radius.md,
          backgroundColor: bg.element,
        }}>
        {toast.phase === 'saved' && (
          <img
            src={toast.url}
            alt=""
            draggable={false}
            style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
          />
        )}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
        <span style={{ ...textSize.sm, lineHeight: 1.3, fontWeight: 600 }}>{title}</span>
        {toast.phase === 'saved' && <SavedLines artifact={toast.artifact} />}
      </span>
    </>
  );

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="screenshot-toast"
      onMouseEnter={onPause}
      onMouseLeave={onResume}>
      {toast.phase === 'saved' ? (
        <button
          type="button"
          aria-label="Download screenshot again"
          onClick={onDownloadAgain}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocus={(event) => setFocused(isFocusVisible(event))}
          onBlur={() => setFocused(false)}
          style={{
            ...PILL_STYLE,
            backgroundColor: hovered ? bg.hover : bg.default,
            boxShadow: focused ? `0 0 0 2px ${border.secondary}, ${shadow.lg}` : shadow.lg,
            outline: 'none',
            cursor: 'pointer',
            transition: 'background-color 120ms ease',
          }}>
          {body}
          <ChevronRightIcon style={{ marginLeft: 'auto', flexShrink: 0, color: text.secondary }} />
        </button>
      ) : (
        <div style={PILL_STYLE}>{body}</div>
      )}
    </div>
  );
}

function SavedLines({ artifact }: { artifact: ScreenshotArtifact | null }) {
  const { message } = artifactNotice(artifact);
  return (
    <>
      <span style={{ ...textSize.xs, lineHeight: 1.3, color: text.secondary }}>Download again</span>
      {message && (
        <span
          style={{
            ...textSize.xs,
            lineHeight: 1.3,
            marginTop: 4,
            overflowWrap: 'anywhere',
            color: artifact?.status === 'failed' ? text.warning : text.tertiary,
          }}>
          {message}
        </span>
      )}
    </>
  );
}
