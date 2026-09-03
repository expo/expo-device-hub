import { type ReactNode, useEffect, useId, useState } from 'react';

import {
  ChevronDownIcon,
  border,
  heading,
  icon,
  text,
  usePrefersReducedMotion,
} from '../primitives';

/** Horizontal inset shared by every right-sidebar section. */
export const SIDEBAR_SECTION_INSET = 16;

const TRANSITION_MS = 200;
const TRANSITION_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * Keep closing content mounted until its collapse transition has finished, so
 * the section can animate shut instead of vanishing.
 */
function useCollapsePresence(open: boolean, reducedMotion: boolean) {
  const [prevOpen, setPrevOpen] = useState(open);
  const [closing, setClosing] = useState(false);

  if (prevOpen !== open) {
    setPrevOpen(open);
    setClosing(!open && !reducedMotion);
  }

  useEffect(() => {
    if (!closing) return;
    const timeout = window.setTimeout(() => setClosing(false), TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [closing]);

  return open || closing;
}

/**
 * An inspector section whose entire title row toggles its contents.
 *
 * Sections stack with a hairline separator above each title. The separator
 * spans the full sidebar width while the title and content keep the shared
 * {@link SIDEBAR_SECTION_INSET}. The title is vertically centered in its row,
 * and the content animates open and closed.
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
  const reducedMotion = usePrefersReducedMotion();
  const present = useCollapsePresence(open, reducedMotion);

  return (
    <section
      aria-label={title}
      style={{
        minWidth: 0,
        boxSizing: 'border-box',
        padding: `0 ${SIDEBAR_SECTION_INSET}px`,
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
          padding: '18px 0',
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
            transition: reducedMotion ? undefined : `transform ${TRANSITION_MS}ms ${TRANSITION_EASING}`,
          }}
        />
      </button>
      <div
        style={{
          display: 'grid',
          gridTemplateRows: open ? '1fr' : '0fr',
          transition: reducedMotion
            ? undefined
            : `grid-template-rows ${TRANSITION_MS}ms ${TRANSITION_EASING}`,
        }}
      >
        <div
          id={contentId}
          aria-hidden={!open || undefined}
          style={{
            minWidth: 0,
            minHeight: 0,
            overflow: 'clip',
            overflowClipMargin: 4,
            opacity: open ? 1 : 0,
            transition: reducedMotion ? undefined : `opacity ${TRANSITION_MS}ms ease`,
          }}
        >
          {present && <div style={{ minWidth: 0, paddingBottom: 12 }}>{children}</div>}
        </div>
      </div>
    </section>
  );
}
