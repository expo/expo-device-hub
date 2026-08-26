import { useEffect, useRef } from 'react';

import {
  agentInteractionCursorExpiresAt,
  agentInteractionEndMs,
  agentInteractionPointsAt,
  agentInteractionPointsWithTravelAt,
  agentInteractionTravelMs,
} from './agent-interaction-animation';
import { AGENT_TOUCH_INDICATOR_STYLE } from './TouchIndicator';
import { type AgentInteraction, type AgentInteractionPoint } from './types';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function AgentInteractionIndicator({
  interaction,
}: {
  interaction?: AgentInteraction | null;
}) {
  const layerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const pointsRef = useRef<AgentInteractionPoint[]>([]);

  const paint = (points: AgentInteractionPoint[]) => {
    pointsRef.current = points;
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
    const activeInteraction = interaction;

    const reduceMotion = window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
    const previousPoints = pointsRef.current;
    const travelMs = reduceMotion ? 0 : agentInteractionTravelMs(previousPoints, activeInteraction);
    const interactionEndMs = agentInteractionEndMs(activeInteraction);
    const endMs = travelMs + interactionEndMs;
    const now = Date.now();
    const parsedTimestamp = Date.parse(activeInteraction.timestamp);
    const interactionStartedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : now;
    const expiresAt = agentInteractionCursorExpiresAt(activeInteraction, interactionStartedAt);
    if (now >= expiresAt) {
      paint([]);
      return;
    }
    const startedAt = travelMs > 0 ? now : interactionStartedAt;
    let frame = 0;
    let fallbackTimer = 0;
    let expiryTimer = 0;

    const hide = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(fallbackTimer);
      fallbackTimer = 0;
      paint([]);
    };

    const scheduleUpdate = () => {
      frame = requestAnimationFrame(() => {
        clearTimeout(fallbackTimer);
        fallbackTimer = 0;
        update();
      });
      // A streamed device can remain visible in a browser whose compositor has
      // paused rAF. Keep the log-timed animation advancing in that case.
      fallbackTimer = window.setTimeout(() => {
        cancelAnimationFrame(frame);
        frame = 0;
        update();
      }, 100);
    };

    function update() {
      if (Date.now() >= expiresAt) {
        hide();
        return;
      }
      const elapsedMs = reduceMotion ? interactionEndMs : Math.max(0, Date.now() - startedAt);
      paint(
        reduceMotion
          ? agentInteractionPointsAt(activeInteraction, elapsedMs)
          : agentInteractionPointsWithTravelAt(activeInteraction, previousPoints, elapsedMs)
      );
      if (!reduceMotion && elapsedMs < endMs) scheduleUpdate();
    }
    expiryTimer = window.setTimeout(hide, expiresAt - now);
    update();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(fallbackTimer);
      clearTimeout(expiryTimer);
    };
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
