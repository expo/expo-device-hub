import { type ReactNode, useEffect, useId, useState } from "react";

import {
  ChevronDownIcon,
  border,
  heading,
  icon,
  motion,
  text,
  usePrefersReducedMotion,
} from "../primitives";

/** Horizontal inset shared by every right-sidebar section. */
export const SIDEBAR_SECTION_INSET = 16;

/** How long a section takes to open or close: the website's 150ms, as a number for the unmount timer. */
export const SECTION_TRANSITION_MS = Number.parseInt(motion.base, 10);
/** The easing of the website's `collapsibleOpen` and `collapsibleClosed` animations. */
const SECTION_EASING = "ease-out";
/** Height of the title row: the website's `h-13`. */
const SECTION_TRIGGER_HEIGHT = 52;

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
    const timeout = window.setTimeout(() => setClosing(false), SECTION_TRANSITION_MS);
    return () => window.clearTimeout(timeout);
  }, [closing]);

  return open || closing;
}

/**
 * An inspector section whose entire title row toggles its contents.
 *
 * It has the look of a section of the website's preview settings
 * (`SimulatorPreviewSection`). Sections stack with a hairline separator above
 * each title. The separator and the title row span the full sidebar width,
 * and the title row takes the subtle surface under the pointer. The title and
 * the content keep the shared {@link SIDEBAR_SECTION_INSET}. The content
 * animates open and closed.
 */
export function CollapsibleSection({
  title,
  open,
  onOpenChange,
  divider = true,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Draw the hairline separator above the title. The first section omits it. */
  divider?: boolean;
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
        boxSizing: "border-box",
        borderTop: divider ? `0.5px solid ${border.default}` : undefined,
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => onOpenChange(!open)}
        // The class gives the row the hover fill and the inset focus ring of the website's sections.
        className="hub-section-trigger"
        style={{
          display: "flex",
          width: "100%",
          height: SECTION_TRIGGER_HEIGHT,
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: `0 ${SIDEBAR_SECTION_INSET}px`,
          boxSizing: "border-box",
          border: 0,
          color: text.default,
          fontFamily: "inherit",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ ...heading.sm, minWidth: 0, color: text.default }}>{title}</span>
        <ChevronDownIcon
          size={16}
          strokeWidth={2}
          color={icon.secondary}
          style={{
            flexShrink: 0,
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            transition: reducedMotion ? undefined : `transform ${motion.base} ${motion.ease}`,
          }}
        />
      </button>
      <div
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: reducedMotion
            ? undefined
            : `grid-template-rows ${motion.base} ${SECTION_EASING}`,
        }}
      >
        <div
          id={contentId}
          aria-hidden={!open || undefined}
          style={{
            minWidth: 0,
            minHeight: 0,
            overflow: "clip",
            overflowClipMargin: 4,
            opacity: open ? 1 : 0,
            transition: reducedMotion ? undefined : `opacity ${motion.base} ${SECTION_EASING}`,
          }}
        >
          {present && (
            <div style={{ minWidth: 0, padding: `0 ${SIDEBAR_SECTION_INSET}px 8px` }}>
              {children}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
