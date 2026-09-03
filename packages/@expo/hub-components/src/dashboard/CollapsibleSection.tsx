import { type ReactNode, useId } from 'react';

import { ChevronDownIcon, border, heading, icon, text } from '../primitives';

/** Horizontal inset shared by every right-sidebar section. */
export const SIDEBAR_SECTION_INSET = 16;

/**
 * An inspector section whose entire title row toggles its contents.
 *
 * Sections stack with a hairline separator above each title. The separator
 * spans the full sidebar width while the title and content keep the shared
 * {@link SIDEBAR_SECTION_INSET}, matching the dashboard inspector design.
 */
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
        boxSizing: 'border-box',
        padding: `0 ${SIDEBAR_SECTION_INSET}px ${open ? 12 : 0}px`,
        borderTop: `1px solid ${border.default}`,
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
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '24px 0 12px',
          boxSizing: 'border-box',
          border: 0,
          backgroundColor: 'transparent',
          color: text.default,
          fontFamily: 'inherit',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ ...heading.sm, minWidth: 0, color: text.default }}>{title}</span>
        <ChevronDownIcon
          size={16}
          strokeWidth={1.5}
          color={icon.default}
          style={{
            flexShrink: 0,
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 160ms cubic-bezier(.4, 0, .2, 1)',
          }}
        />
      </button>
      {open && (
        <div id={contentId} style={{ minWidth: 0 }}>
          {children}
        </div>
      )}
    </section>
  );
}
