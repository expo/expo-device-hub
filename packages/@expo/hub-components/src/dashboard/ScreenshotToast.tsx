import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast as sonnerToast } from 'sonner';

import { type DeviceClient, type ScreenshotArtifact } from '@expo/hub-client';
import { bg, border, ChevronRightIcon, isFocusVisible, radius, shadow, text, textSize } from '../primitives';

export type ScreenshotToastState =
  | { phase: 'capturing' }
  | { phase: 'saved'; url: string; artifact: ScreenshotArtifact | null }
  | { phase: 'capture-failed' };

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

export const DEVICE_TOASTER_ID = 'hub-device';

/** Where the screenshot and clipboard toasts render: the bottom-right corner of the viewport, clear of the toolbar. */
export function ScreenshotToaster() {
  return (
    <Toaster
      id={DEVICE_TOASTER_ID}
      position="bottom-right"
      offset={16}
      gap={8}
      toastOptions={{ unstyled: true }}
      // Sonner's default Alt+T moves focus to the toasts, which would steal keys from the device.
      // No key has the code ' ', so this disables the hotkey and keeps the region label clean.
      hotkey={[' ']}
      containerAriaLabel="Device notifications"
    />
  );
}

/**
 * Captures a screenshot, downloads it, and shows the toast that reports it. Each saved toast keeps
 * the PNG's object URL alive for its thumbnail and "Download again" until it closes.
 */
export function useScreenshotToast(client: DeviceClient, deviceName: string) {
  const inFlight = useRef(false);
  const open = useRef(new Map<string | number, string | null>());

  useEffect(
    () => () => {
      for (const [id, url] of open.current) {
        sonnerToast.dismiss(id);
        if (url) URL.revokeObjectURL(url);
      }
      open.current.clear();
    },
    [],
  );

  return useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = sonnerToast.custom(() => <ScreenshotToast toast={{ phase: 'capturing' }} />, {
      toasterId: DEVICE_TOASTER_ID,
      duration: Infinity,
    });
    open.current.set(id, null);
    const close = () => {
      const url = open.current.get(id);
      if (url) URL.revokeObjectURL(url);
      open.current.delete(id);
    };
    try {
      const shot = await client.screenshot();
      if (!open.current.has(id)) return;
      if (!shot) {
        sonnerToast.custom(() => <ScreenshotToast toast={{ phase: 'capture-failed' }} />, {
          id,
          toasterId: DEVICE_TOASTER_ID,
          duration: FAILED_DISMISS_MS,
          onDismiss: close,
          onAutoClose: close,
        });
        return;
      }
      const url = URL.createObjectURL(shot.blob);
      open.current.set(id, url);
      const filename = screenshotFilename(deviceName);
      download(url, filename);
      const { dismissMs } = artifactNotice(shot.artifact);
      // Sonner holds the toast while it is hovered; keyboard focus holds it here.
      const show = (duration: number) =>
        sonnerToast.custom(
          () => (
            <ScreenshotToast
              toast={{ phase: 'saved', url, artifact: shot.artifact }}
              onDownloadAgain={() => download(url, filename)}
              onFocusChange={(focused) => show(focused ? Infinity : dismissMs)}
            />
          ),
          { id, toasterId: DEVICE_TOASTER_ID, duration, onDismiss: close, onAutoClose: close },
        );
      show(dismissMs);
    } finally {
      inFlight.current = false;
    }
  }, [client, deviceName]);
}

export const TOAST_PILL_STYLE = {
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
 * "Download again" action and the session artifact outcome.
 */
export function ScreenshotToast({
  toast,
  onDownloadAgain,
  onFocusChange,
}: {
  toast: ScreenshotToastState;
  onDownloadAgain?: () => void;
  onFocusChange?: (focused: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

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

  if (toast.phase !== 'saved') {
    return (
      <div data-testid="screenshot-toast" style={TOAST_PILL_STYLE}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="screenshot-toast"
      aria-label="Download screenshot again"
      onClick={onDownloadAgain}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => {
        setFocused(isFocusVisible(event));
        onFocusChange?.(true);
      }}
      onBlur={() => {
        setFocused(false);
        onFocusChange?.(false);
      }}
      style={{
        ...TOAST_PILL_STYLE,
        backgroundColor: hovered ? bg.hover : bg.default,
        boxShadow: focused ? `0 0 0 2px ${border.secondary}, ${shadow.lg}` : shadow.lg,
        outline: 'none',
        cursor: 'pointer',
        transition: 'background-color 120ms ease',
      }}>
      {body}
      <ChevronRightIcon style={{ marginLeft: 'auto', flexShrink: 0, color: text.secondary }} />
    </button>
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
