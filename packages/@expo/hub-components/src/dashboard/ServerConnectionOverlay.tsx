import { useEffect, useRef } from 'react';

import {
  Button,
  CableDisconnectIcon,
  Logo,
  RefreshIcon,
  bg,
  border,
  font,
  heading,
  icon,
  radius,
  shadow,
  text,
  textSize,
} from '../primitives';

export type ServerConnectionOverlayProps = {
  status: 'connecting' | 'disconnected';
  onReconnect: () => void;
};

type InertableElement = Pick<HTMLElement, 'inert'>;

/** Temporarily removes a body-level portal from pointer, keyboard, and assistive-tech access. */
export function temporarilyInertElement(element: InertableElement): (() => void) | null {
  if (element.inert) return null;
  element.inert = true;
  return () => {
    element.inert = false;
  };
}

/** Full-page blocker shown until the dashboard can verify its dev server connection. */
export function ServerConnectionOverlay({ status, onReconnect }: ServerConnectionOverlayProps) {
  const connecting = status === 'connecting';
  const overlayRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;

    const restorers = new Map<HTMLElement, () => void>();
    const blockBodyChild = (node: Node) => {
      if (!(node instanceof HTMLElement) || node === overlay || node.contains(overlay)) return;
      const restore = temporarilyInertElement(node);
      if (restore) restorers.set(node, restore);
    };

    for (const child of document.body.children) blockBodyChild(child);

    // A pending dashboard action can open a new Radix portal after the
    // connection drops, so block body children added while the overlay is live.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) blockBodyChild(node);
      }
    });
    observer.observe(document.body, { childList: true });

    // Move focus out of any dialog focus trap that was open when the server
    // disconnected. Its portal is inert by this point and cannot reclaim focus.
    overlay.focus({ preventScroll: true });

    return () => {
      observer.disconnect();
      for (const restore of restorers.values()) restore();
    };
  }, []);

  return (
    <main
      ref={overlayRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="server-connection-overlay-title"
      aria-describedby="server-connection-overlay-description"
      aria-busy={connecting}
      tabIndex={-1}
      style={{
        position: 'fixed',
        inset: 0,
        // Above the shared dialog/select portal stack, which tops out at 605.
        zIndex: 610,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        minWidth: 0,
        minHeight: '100vh',
        padding: 24,
        backgroundColor: `color-mix(in srgb, ${bg.screen} 68%, transparent)`,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        color: text.default,
        fontFamily: font.sans,
        outline: 'none',
        pointerEvents: 'auto',
      }}>
      <section
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
          maxWidth: 440,
          padding: '40px 32px',
          boxSizing: 'border-box',
          backgroundColor: `color-mix(in srgb, ${bg.default} 92%, transparent)`,
          border: `1px solid ${border.secondary}`,
          borderRadius: radius.xl,
          boxShadow: shadow.sm,
          textAlign: 'center',
        }}>
        <Logo style={{ marginBottom: 32 }} />
        <div
          aria-hidden="true"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            marginBottom: 20,
            border: `1px solid ${border.secondary}`,
            borderRadius: radius.full,
            backgroundColor: connecting ? bg.subtle : bg.default,
          }}>
          {connecting ? (
            <RefreshIcon size={24} color={icon.secondary} />
          ) : (
            <CableDisconnectIcon size={24} color={icon.default} />
          )}
        </div>
        <div aria-live="assertive">
          <h1
            id="server-connection-overlay-title"
            style={{ ...heading['2xl'], margin: 0, color: text.default }}>
            {connecting ? 'Connecting to the Expo dev server' : 'Server disconnected'}
          </h1>
          <p
            id="server-connection-overlay-description"
            style={{
              ...textSize.sm,
              maxWidth: 360,
              margin: '12px 0 0',
              color: text.secondary,
            }}>
            {connecting ? (
              'If this takes more than a few seconds, restart the Expo dev server in your terminal. Expo Hub will reconnect automatically once it is available.'
            ) : (
              <>
                Restart the server in your terminal.
                <br />
                Once it is running, reconnect without losing this page.
              </>
            )}
          </p>
        </div>
        <Button
          theme="primary"
          size="lg"
          leftSlot={<RefreshIcon size={18} />}
          onClick={onReconnect}
          style={{ marginTop: 24 }}>
          Reconnect
        </Button>
      </section>
    </main>
  );
}
