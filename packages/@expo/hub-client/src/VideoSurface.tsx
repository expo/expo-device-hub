import { type CSSProperties, useLayoutEffect, useRef } from 'react';

import type { DeviceClient } from './types';

/** The client can cover an unready replacement video with its previous frame. */
export function VideoSurface({
  attachVideo,
  style,
}: {
  attachVideo: DeviceClient['attachVideo'];
  style: CSSProperties;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const retainedFrameRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    attachVideo(videoRef.current, retainedFrameRef.current);
    return () => attachVideo(null);
  }, [attachVideo]);

  return (
    <>
      <video ref={videoRef} autoPlay muted playsInline style={style} />
      <canvas
        ref={retainedFrameRef}
        aria-hidden="true"
        style={{ ...style, visibility: 'hidden' }}
      />
    </>
  );
}
