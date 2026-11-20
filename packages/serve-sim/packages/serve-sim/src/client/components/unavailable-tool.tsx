import { useState } from "react";
import { CollapsibleSection } from "./collapsible-section";

/** A tool the device does not have keeps its place and says why, as the Hub's inspector does. */
export function UnavailableTool({ title, reason }: { title: string; reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <CollapsibleSection
      open={open}
      onOpenChange={setOpen}
      data-unavailable-tool={title}
      summary={
        <span className="text-[11px] font-semibold text-white/50 uppercase tracking-[0.08em] leading-none inline-flex items-center">
          {title}
        </span>
      }
    >
      <p className="text-[12px] text-white/60 leading-snug m-0">{reason}</p>
    </CollapsibleSection>
  );
}
