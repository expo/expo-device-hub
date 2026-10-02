import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
import { type ReactNode, useEffect, useState } from 'react';

import { Button, ControlButton, bg, border, font, radius, shadow, text, textSize } from '../primitives';

export type ShareLink = {
  /** The link Share copies. */
  url: string;
  /** The link carries the Hub's session token, so whoever has it can control the devices. */
  carriesToken: boolean;
};

const COPIED_MS = 2_500;

/**
 * `navigator.clipboard` exists only in a secure context. A Hub on a LAN address over plain http
 * is not one, so fall back to the legacy selection copy.
 */
export async function copyTextToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
    // A denied or rejected write falls through to the legacy copy below.
  } catch {}
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    try {
      area.select();
      area.setSelectionRange(0, value.length);
      return document.execCommand('copy');
    } finally {
      area.remove();
    }
  } catch {
    return false;
  }
}

function linkNote(carriesToken: boolean): string {
  return carriesToken
    ? 'The link includes the access token. Anyone who has it can control the devices on this Hub.'
    : 'Anyone who can reach this address can open it.';
}

/**
 * Copies a link to this Hub, as serve-sim's Share button does. The tooltip confirms the copy;
 * when the browser refuses it, a panel shows the link to copy by hand.
 */
export function ShareButton({ icon, url, carriesToken }: ShareLink & { icon: ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const copied = carriesToken ? 'Link copied. It includes the access token.' : 'Share link copied';
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <ControlButton
        icon={icon}
        label="Share"
        tooltip={
          state === 'copied'
            ? copied
            : carriesToken
              ? 'Copy share link (includes access token)'
              : 'Copy share link'
        }
        tooltipOpen={state === 'copied' ? true : state === 'manual' ? false : undefined}
        onClick={() => {
          void copyTextToClipboard(url).then((ok) => setState(ok ? 'copied' : 'manual'));
        }}
      />
      <VisuallyHidden>
        <span role="status">{state === 'copied' ? copied : ''}</span>
      </VisuallyHidden>
      {state === 'manual' && (
        <ShareLinkPanel url={url} carriesToken={carriesToken} onDone={() => setState('idle')} />
      )}
    </span>
  );
}

/** The link to copy by hand, above the toolbar, when the browser refused the copy. */
export function ShareLinkPanel({ url, carriesToken, onDone }: ShareLink & { onDone: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Share link"
      style={{
        position: 'absolute',
        right: 0,
        bottom: 'calc(100% + 12px)',
        zIndex: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 'min(360px, calc(100vw - 32px))',
        padding: 12,
        boxSizing: 'border-box',
        border: `1px solid ${border.default}`,
        borderRadius: radius.lg,
        backgroundColor: bg.default,
        boxShadow: shadow.md,
      }}>
      <span style={{ ...textSize.sm, fontWeight: 600, color: text.default }}>
        Copy this share link
      </span>
      <input
        readOnly
        autoFocus
        value={url}
        aria-label="Share link"
        onFocus={(event) => event.currentTarget.select()}
        style={{
          ...textSize.xs,
          width: '100%',
          minWidth: 0,
          height: 32,
          padding: '0 8px',
          boxSizing: 'border-box',
          border: `1px solid ${border.default}`,
          borderRadius: radius.md,
          backgroundColor: bg.subtle,
          color: text.default,
          fontFamily: font.mono,
        }}
      />
      <span style={{ ...textSize.xs, color: text.secondary }}>{linkNote(carriesToken)}</span>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button theme="secondary" size="xs" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
