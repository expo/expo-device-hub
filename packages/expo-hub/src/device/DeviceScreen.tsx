import { type CSSProperties, type PointerEvent as ReactPointerEvent, useRef } from 'react';

import { type DeviceScreenProps, type TouchSample } from './types';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// Custom round cursor matching serve-sim's finger dot, so taps feel placed.
const FINGER_CURSOR =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(255,255,255,0.45)' stroke='rgba(0,0,0,0.55)' stroke-width='1.25'/%3E%3C/svg%3E") 12 12, pointer`;

/**
 * Shared renderer for a live {@link DeviceClient}, used in place of the static
 * `<img>` inside {@link PhoneFrame}. It paints whatever element the active
 * implementation asks for (`<canvas>` for serve-emu H.264, `<img>` for serve-sim
 * MJPEG) and forwards normalized pointer input through `client.sendTouch`.
 *
 * The hook owns the wire protocol; this component owns the DOM: it measures the
 * surface, normalizes pointer coordinates to 0..1, throttles moves to one per
 * animation frame, and captures the pointer so drags keep tracking off-element.
 */
export function DeviceScreen({ client, borderRadius, squircle }: DeviceScreenProps) {
  const { videoKind, attachVideo, sendTouch, status, error } = client;

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const activePointerRef = useRef<number | null>(null);
  const pendingMoveRef = useRef<TouchSample | null>(null);
  const moveRafRef = useRef(0);

  const pointFrom = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
  };

  const flushMove = () => {
    moveRafRef.current = 0;
    const next = pendingMoveRef.current;
    if (next && activePointerRef.current !== null) {
      pendingMoveRef.current = null;
      sendTouch(next);
    }
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (activePointerRef.current !== null) return;
    const point = pointFrom(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    try {
      surfaceRef.current?.setPointerCapture(event.pointerId);
    } catch {}
    activePointerRef.current = event.pointerId;
    pendingMoveRef.current = null;
    sendTouch({ phase: 'begin', ...point });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    const native = event.nativeEvent;
    const coalesced =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : null;
    const last = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : event;
    const point = pointFrom(last.clientX, last.clientY);
    if (!point) return;
    event.preventDefault();
    pendingMoveRef.current = { phase: 'move', ...point };
    if (!moveRafRef.current) moveRafRef.current = requestAnimationFrame(flushMove);
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== activePointerRef.current) return;
    event.preventDefault();
    if (moveRafRef.current) {
      cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
    }
    const point = pointFrom(event.clientX, event.clientY) ?? pendingMoveRef.current ?? { x: 0.5, y: 0.5 };
    pendingMoveRef.current = null;
    activePointerRef.current = null;
    try {
      surfaceRef.current?.releasePointerCapture(event.pointerId);
    } catch {}
    sendTouch({ phase: 'end', x: point.x, y: point.y });
  };

  const surfaceStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#000',
    borderRadius,
    ...(squircle ? ({ cornerShape: 'squircle' } as Record<string, unknown>) : {}),
  };

  const mediaStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    pointerEvents: 'none',
  };

  return (
    <div style={surfaceStyle}>
      {videoKind === 'canvas' ? (
        <canvas ref={attachVideo} style={mediaStyle} />
      ) : (
        <img ref={attachVideo} alt="Device screen" draggable={false} style={mediaStyle} />
      )}

      {/* Input overlay: captures all pointer events and forwards them. */}
      <div
        ref={surfaceRef}
        style={{ position: 'absolute', inset: 0, cursor: FINGER_CURSOR, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onContextMenu={(event) => event.preventDefault()}
      />

      {status !== 'streaming' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            textAlign: 'center',
            pointerEvents: 'none',
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            color: status === 'error' ? '#fca5a5' : 'rgba(255, 255, 255, 0.7)',
            fontSize: 13,
            fontFamily: 'var(--expo-font-mono)',
          }}>
          {status === 'error'
            ? (error ?? 'Disconnected')
            : status === 'connecting'
              ? 'Connecting…'
              : 'Not connected'}
        </div>
      )}
    </div>
  );
}
