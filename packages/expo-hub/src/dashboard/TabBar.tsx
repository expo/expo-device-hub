import { type CSSProperties, useState } from 'react';

import { bg, radius, text, textSize } from '../../theme/tokens';
import { tabs, type TabKey } from './data';

/** Logs / Network / Settings tab switcher for the selected simulator. */
export function TabBar({ active, onChange }: { active: TabKey; onChange: (key: TabKey) => void }) {
  const [hovered, setHovered] = useState<TabKey | null>(null);

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        const isHovered = hovered === tab.key && !selected;
        const style: CSSProperties = {
          padding: '6px 16px',
          border: 'none',
          borderRadius: radius.lg,
          backgroundColor: selected ? bg.hover : isHovered ? bg.element : 'transparent',
          color: selected || isHovered ? text.default : text.secondary,
          cursor: 'pointer',
          fontFamily: 'inherit',
          transition: 'background-color 150ms ease, color 150ms ease',
          ...textSize.sm,
          fontWeight: 500,
        };
        return (
          <button
            key={tab.key}
            type="button"
            style={style}
            onClick={() => onChange(tab.key)}
            onMouseEnter={() => setHovered(tab.key)}
            onMouseLeave={() => setHovered(null)}>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
