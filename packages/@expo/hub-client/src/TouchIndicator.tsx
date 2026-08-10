import { type CSSProperties } from 'react';

import { type AgentInteractionPoint } from './types';

export const TOUCH_INDICATOR_STYLE: CSSProperties = {
  position: 'absolute',
  width: 20,
  height: 20,
  borderRadius: '50%',
  background: 'rgba(255, 255, 255, 0.45)',
  border: '1.25px solid rgba(0, 0, 0, 0.55)',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.45)',
  pointerEvents: 'none',
  boxSizing: 'border-box',
};

export const AGENT_TOUCH_INDICATOR_STYLE: CSSProperties = {
  ...TOUCH_INDICATOR_STYLE,
  border: '2px solid rgba(48, 48, 48, 0.95)',
};

export function TouchIndicator({ point }: { point: AgentInteractionPoint }) {
  return (
    <div
      style={{
        ...TOUCH_INDICATOR_STYLE,
        left: `${point.x * 100}%`,
        top: `${point.y * 100}%`,
        transform: 'translate(-50%, -50%)',
      }}
    />
  );
}
