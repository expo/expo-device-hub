import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { streamGeometry } from './orientation';
import { type DeviceScreenProps, type MultiTouchSample } from './types';

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

type Point = { x: number; y: number };

// Custom round cursor matching serve-sim's finger dot, so taps feel placed.
const FINGER_CURSOR =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='9' fill='rgba(255,255,255,0.45)' stroke='rgba(0,0,0,0.55)' stroke-width='1.25'/%3E%3C/svg%3E") 12 12, pointer`;

/**
 * Shared renderer for a live {@link DeviceClient}, used in place of the static
 * `<img>` inside {@link PhoneFrame}. It paints whatever element the active
 * implementation asks for (`<canvas>` for serve-emu H.264, `<img>` for serve-sim
 * MJPEG) and forwards normalized pointer input.
 *
 * Input is measured in *display* space (the hook remaps to the device's raw
 * frame for the current orientation). Single-finger drags go through
 * `client.sendTouch`; two-finger pinch/pan (real touch, or Alt-drag with a
 * mouse) goes through `client.sendMultiTouch` when the backend supports it. When
 * the stream is rotated for a non-portrait device, only the video element is
 * CSS-rotated — the input overlay stays display-aligned.
 */
export function DeviceScreen({ client, borderRadius, squircle }: DeviceScreenProps) {
  const { videoKind, attachVideo, sendTouch, sendMultiTouch, screen, status, error } = client;
  const canMulti = !!sendMultiTouch;

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Measure the surface so a rotated video can be sized to fill it.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── pointer state ──
  const pointersRef = useRef(new Map<number, Point>());
  const modeRef = useRef<'none' | 'single' | 'alt' | 'two'>('none');
  const singleIdRef = useRef<number | null>(null);
  const altShiftRef = useRef(false);
  const panOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const [fingers, setFingers] = useState<{ a: Point; b: Point } | null>(null);

  // rAF move throttle (latest-wins) for both single and multi.
  const pendingRef = useRef<{ single?: Point; multi?: MultiTouchSample }>({});
  const rafRef = useRef(0);
  const flush = () => {
    rafRef.current = 0;
    const pend = pendingRef.current;
    pendingRef.current = {};
    if (pend.single) sendTouch({ phase: 'move', ...pend.single });
    if (pend.multi) {
      sendMultiTouch?.(pend.multi);
      setFingers({ a: pend.multi.a, b: pend.multi.b });
    }
  };
  const queueFrame = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
  };

  const pointFrom = (clientX: number, clientY: number): Point | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
  };

  // Second finger position for Alt-drag: mirror around center (pinch) or a
  // locked offset (pan, with Shift) — matches serve-sim.
  const altSecondFinger = (p: Point): Point =>
    altShiftRef.current
      ? { x: clamp01(p.x + panOffsetRef.current.x), y: clamp01(p.y + panOffsetRef.current.y) }
      : { x: 1 - p.x, y: 1 - p.y };

  const endMulti = (a: Point, b: Point) => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    pendingRef.current = {};
    sendMultiTouch?.({ phase: 'end', a, b });
    setFingers(null);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const p = pointFrom(event.clientX, event.clientY);
    if (!p) return;
    event.preventDefault();
    try {
      surfaceRef.current?.setPointerCapture(event.pointerId);
    } catch {}
    pointersRef.current.set(event.pointerId, p);

    // Alt-drag with a mouse → synthetic pinch/pan.
    if (canMulti && event.pointerType === 'mouse' && event.altKey && modeRef.current === 'none') {
      modeRef.current = 'alt';
      altShiftRef.current = event.shiftKey;
      panOffsetRef.current = { x: 1 - 2 * p.x, y: 1 - 2 * p.y };
      const b = altSecondFinger(p);
      setFingers({ a: p, b });
      sendMultiTouch?.({ phase: 'begin', a: p, b });
      return;
    }

    // Second finger down → real two-finger gesture.
    if (canMulti && pointersRef.current.size >= 2 && modeRef.current !== 'alt') {
      if (modeRef.current === 'single') {
        sendTouch({ phase: 'end', ...p });
        singleIdRef.current = null;
      }
      const [a, b] = [...pointersRef.current.values()];
      modeRef.current = 'two';
      setFingers({ a, b });
      sendMultiTouch?.({ phase: 'begin', a, b });
      return;
    }

    if (modeRef.current === 'none') {
      modeRef.current = 'single';
      singleIdRef.current = event.pointerId;
      sendTouch({ phase: 'begin', ...p });
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stored = pointersRef.current.get(event.pointerId);
    if (!stored) return;
    const native = event.nativeEvent;
    const coalesced =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : null;
    const last = coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] : event;
    const p = pointFrom(last.clientX, last.clientY);
    if (!p) return;
    event.preventDefault();
    pointersRef.current.set(event.pointerId, p);

    if (modeRef.current === 'alt') {
      pendingRef.current.multi = { phase: 'move', a: p, b: altSecondFinger(p) };
      queueFrame();
    } else if (modeRef.current === 'two') {
      const [a, b] = [...pointersRef.current.values()];
      pendingRef.current.multi = { phase: 'move', a, b };
      queueFrame();
    } else if (modeRef.current === 'single' && event.pointerId === singleIdRef.current) {
      pendingRef.current.single = p;
      queueFrame();
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const stored = pointersRef.current.get(event.pointerId);
    if (!stored) return;
    event.preventDefault();
    const p = pointFrom(event.clientX, event.clientY) ?? stored;
    try {
      surfaceRef.current?.releasePointerCapture(event.pointerId);
    } catch {}

    if (modeRef.current === 'alt') {
      endMulti(p, altSecondFinger(p));
      modeRef.current = 'none';
      pointersRef.current.clear();
      return;
    }
    if (modeRef.current === 'two') {
      const [a, b] = [...pointersRef.current.values()];
      endMulti(a ?? p, b ?? p);
      modeRef.current = 'none';
      pointersRef.current.clear();
      return;
    }
    if (modeRef.current === 'single' && event.pointerId === singleIdRef.current) {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pendingRef.current = {};
      sendTouch({ phase: 'end', ...p });
      modeRef.current = 'none';
      singleIdRef.current = null;
    }
    pointersRef.current.delete(event.pointerId);
  };

  // ── display geometry (rotation for non-portrait devices) ──
  const geometry = streamGeometry(screen);
  const rotation = geometry.rotationDegrees;
  const rotatesSideways = Math.abs(rotation) === 90;

  const surfaceStyle: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: '#000',
    borderRadius,
    ...(squircle ? ({ cornerShape: 'superellipse(1.3)' } as Record<string, unknown>) : {}),
  };

  const mediaStyle: CSSProperties =
    rotation === 0
      ? {
          display: 'block',
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
        }
      : {
          display: 'block',
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: rotatesSideways && size ? `${size.h}px` : '100%',
          height: rotatesSideways && size ? `${size.w}px` : '100%',
          transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          transformOrigin: 'center center',
          objectFit: 'cover',
        };
  Object.assign(mediaStyle, { userSelect: 'none', WebkitUserSelect: 'none', pointerEvents: 'none' });

  return (
    <div style={surfaceStyle}>
      {videoKind === 'canvas' ? (
        <canvas ref={attachVideo} style={mediaStyle} />
      ) : (
        <img ref={attachVideo} alt="Device screen" draggable={false} style={mediaStyle} />
      )}

      {/* Input overlay: display-aligned, captures all pointer events. */}
      <div
        ref={surfaceRef}
        style={{ position: 'absolute', inset: 0, cursor: FINGER_CURSOR, touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />

      {/* Two-finger indicator dots. */}
      {fingers && (
        <>
          <FingerDot point={fingers.a} />
          <FingerDot point={fingers.b} />
        </>
      )}

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

function FingerDot({ point }: { point: Point }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: `${point.x * 100}%`,
        top: `${point.y * 100}%`,
        width: 20,
        height: 20,
        borderRadius: '50%',
        background: 'rgba(255, 255, 255, 0.45)',
        border: '1.25px solid rgba(0, 0, 0, 0.55)',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.45)',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
      }}
    />
  );
}
