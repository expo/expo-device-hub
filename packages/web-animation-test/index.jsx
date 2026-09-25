import '@expo/metro-runtime';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

import './style.css';

function FrameCounters() {
  const fpsRef = useRef(null);
  const framesRef = useRef(null);

  useEffect(() => {
    let totalFrames = 0;
    let sampleFrames = 0;
    let sampleStart = performance.now();
    let animationFrame;

    function resetSample() {
      sampleFrames = 0;
      sampleStart = performance.now();
      fpsRef.current.textContent = '—';
    }

    function tick(now) {
      totalFrames += 1;
      sampleFrames += 1;
      framesRef.current.textContent = String(totalFrames);

      const elapsed = now - sampleStart;
      if (elapsed >= 1000) {
        fpsRef.current.textContent = String(Math.round((sampleFrames * 1000) / elapsed));
        sampleFrames = 0;
        sampleStart = now;
      }

      animationFrame = requestAnimationFrame(tick);
    }

    animationFrame = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', resetSample);
    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener('visibilitychange', resetSample);
    };
  }, []);

  return (
    <div className="counters" role="group" aria-label="Browser frame counters">
      <span>FPS: <span ref={fpsRef}>—</span></span>
      <span>Frames: <span ref={framesRef}>0</span></span>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <>
    <FrameCounters />
    <section />
    <div className="shape" />
  </>
);
