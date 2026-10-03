/**
 * Mounts the iPhone Duo 3D scene over hidden panel streams, ported from
 * serve-sim's `src/client/components/duo-model-view.tsx` (@expo/serve-sim 0.5.0).
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { createDuoScene, type DuoSceneState } from './duo-scene';
import { DuoHingeHandle } from './DuoHingeHandle';

export interface DuoModelViewProps extends DuoSceneState {
  /** The panel feeds. They stay mounted while their frames texture the model. */
  children: ReactNode;
}

const STATUS_STYLE: CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '6px 12px',
  borderRadius: 8,
  backgroundColor: 'rgba(0, 0, 0, 0.55)',
  color: 'rgba(255, 255, 255, 0.85)',
  fontSize: 12,
  fontFamily: 'var(--expo-font-mono)',
  textAlign: 'center',
  pointerEvents: 'none',
};

/** The stream stays mounted while its decoded frames texture the articulated model. */
export function DuoModelView({ children, ...props }: DuoModelViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const source = useRef<HTMLDivElement>(null);
  const hingeHandle = useRef<HTMLDivElement>(null);
  const oppositeHingeHandle = useRef<HTMLDivElement>(null);
  const latest = useRef<DuoSceneState>(props);
  latest.current = props;
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    if (!host.current || !source.current) return;
    let disposed = false;
    const scene = createDuoScene(
      host.current,
      source.current,
      () => latest.current,
      {
        ready: () => {
          if (!disposed) setStatus('ready');
        },
        error: () => {
          if (!disposed) {
            setStatus('unavailable');
            latest.current.onUnavailable?.();
          }
        },
      },
      { left: hingeHandle.current ?? undefined, right: oppositeHingeHandle.current ?? undefined },
    );
    return () => {
      disposed = true;
      scene.dispose();
    };
  }, []);

  const angle = props.angle ?? (props.streamConfig?.screenId === 1 ? 0 : 180);
  const onHingeAngleChange = status === 'ready' ? props.onHingeAngleChange : undefined;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} data-duo-model={status}>
      <div
        ref={source}
        aria-hidden={status !== 'unavailable'}
        style={
          status === 'unavailable'
            ? { width: '100%', height: '100%' }
            : { position: 'absolute', inset: 0, opacity: 0, pointerEvents: 'none', overflow: 'hidden' }
        }
      >
        {children}
      </div>
      <div
        ref={host}
        role="img"
        aria-label={`iPhone Duo 3D preview, ${props.pose ?? 'custom'} pose${
          props.angle === undefined ? '' : `, ${Math.round(props.angle)} degrees`
        }`}
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          display: status === 'unavailable' ? 'none' : undefined,
          touchAction: 'none',
        }}
      />
      <DuoHingeHandle handleRef={hingeHandle} side="left" angle={angle} onChange={onHingeAngleChange} />
      <DuoHingeHandle
        handleRef={oppositeHingeHandle}
        side="right"
        angle={angle}
        onChange={onHingeAngleChange}
      />
      {status === 'loading' && (
        <span role="status" style={{ ...STATUS_STYLE, left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }}>
          Loading iPhone Duo…
        </span>
      )}
      {props.streamError && (
        <span
          role="alert"
          style={{ ...STATUS_STYLE, left: 16, right: 16, bottom: 16, backgroundColor: 'rgba(0, 0, 0, 0.9)', color: '#fca5a5' }}
        >
          {props.streamError}
        </span>
      )}
      {status === 'unavailable' && (
        <span role="status" style={{ ...STATUS_STYLE, left: 16, right: 16, bottom: 8 }}>
          3D preview unavailable. Showing the live display.
        </span>
      )}
    </div>
  );
}
