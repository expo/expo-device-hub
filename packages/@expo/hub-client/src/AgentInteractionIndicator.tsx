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
  const layerRefs = useRef<Array<HTMLDivElement | null>>([]);

  const paint = (points: AgentInteractionPoint[]) => {
    for (let index = 0; index < layerRefs.current.length; index++) {
      const layer = layerRefs.current[index];
      if (!layer) continue;
      const point = points[index];
      layer.hidden = !point;
      if (point) {
        layer.style.transform = `translate3d(${point.x * 100}%, ${point.y * 100}%, 0)`;
      }
    }
  };

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
      aria-hidden="true"
      data-testid="agent-interaction-indicator"
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}
    >
      {[0, 1].map((index) => (
        <div
          key={index}
          ref={(element) => {
            layerRefs.current[index] = element;
          }}
          hidden
          style={{ position: 'absolute', inset: 0, willChange: 'transform' }}
        >
          <div
            data-agent-touch={index}
            style={{
              ...AGENT_TOUCH_INDICATOR_STYLE,
              left: 0,
              top: 0,
              transform: 'translate(-50%, -50%)',
            }}
          />
        </div>
      ))}
    </div>
  );
}
