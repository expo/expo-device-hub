import { useEffect, useRef } from 'react';

import { agentInteractionEndMs, agentInteractionPointsAt } from './agent-interaction-animation';
import { AGENT_TOUCH_INDICATOR_STYLE } from './TouchIndicator';
import { type AgentInteraction, type AgentInteractionPoint } from './types';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function AgentInteractionIndicator({
  interaction,
}: {
  interaction?: AgentInteraction | null;
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const dotRefs = useRef<Array<HTMLDivElement | null>>([]);
  const sizeRef = useRef({ width: 0, height: 0 });
  const pointsRef = useRef<AgentInteractionPoint[]>([]);

  const paint = (points: AgentInteractionPoint[]) => {
    pointsRef.current = points;
    const { width, height } = sizeRef.current;
    for (let index = 0; index < dotRefs.current.length; index++) {
      const dot = dotRefs.current[index];
      if (!dot) continue;
      const point = points[index];
      dot.hidden = !point;
      if (point) {
        dot.style.transform = `translate3d(${point.x * width}px, ${point.y * height}px, 0) translate(-50%, -50%)`;
      }
    }
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (!rect) return;
      sizeRef.current = { width: rect.width, height: rect.height };
      paint(pointsRef.current);
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!interaction) {
      paint([]);
      return;
    }

    const reduceMotion = window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
    const endMs = agentInteractionEndMs(interaction);
    const parsedTimestamp = Date.parse(interaction.timestamp);
    const startedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : Date.now();
    let frame = 0;

    const update = () => {
      const elapsedMs = reduceMotion ? endMs : Math.max(0, Date.now() - startedAt);
      paint(agentInteractionPointsAt(interaction, elapsedMs));
      if (!reduceMotion && elapsedMs < endMs) frame = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(frame);
  }, [interaction]);

  return (
    <div
      ref={surfaceRef}
      aria-hidden="true"
      data-testid="agent-interaction-indicator"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {[0, 1].map((index) => (
        <div
          key={index}
          ref={(element) => {
            dotRefs.current[index] = element;
          }}
          data-agent-touch={index}
          hidden
          style={{ ...AGENT_TOUCH_INDICATOR_STYLE, left: 0, top: 0, willChange: 'transform' }}
        />
      ))}
    </div>
  );
}
