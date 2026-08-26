import { type ReactNode, useId } from 'react';

import { ChevronDownIcon, border, icon, text, textSize } from '../primitives';

/** A compact inspector section whose entire title row toggles its contents. */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const contentId = useId();

  return (
    <section
      aria-label={title}
      style={{
        minWidth: 0,
        borderBottom: `1px solid ${border.secondary}`,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        style={{
          display: 'flex',
          width: '100%',
          minHeight: 40,
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '8px 0',
          boxSizing: 'border-box',
          border: 0,
          backgroundColor: 'transparent',
          color: text.tertiary,
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            ...textSize.xs,
            color: text.tertiary,
            fontWeight: 500,
          }}
        >
          {title}
        </span>
        <ChevronDownIcon
          size={14}
          color={icon.tertiary}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 160ms cubic-bezier(.4, 0, .2, 1)',
          }}
        />
      </button>
      {open && (
        <div id={contentId} style={{ minWidth: 0, paddingBottom: 8 }}>
          {children}
        </div>
      )}
    </section>
  );
}
