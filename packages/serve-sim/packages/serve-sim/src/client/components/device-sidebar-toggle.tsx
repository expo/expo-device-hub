import { PanelLeft } from "lucide-react";
import { IconButton } from "./icon-button";
import { ServeSimBrandLink } from "./serve-sim-brand-link";

export function DeviceSidebarToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <div
      className={`fixed top-3 left-3 z-30 flex items-center gap-1 p-1 [transition:opacity_0.18s_ease] ${open ? "opacity-0 pointer-events-none" : "opacity-100 pointer-events-auto"}`}
    >
      <IconButton
        onClick={onClick}
        aria-label="Open devices sidebar"
        aria-pressed={open}
        title="Devices"
      >
        <PanelLeft size={18} strokeWidth={1.75} />
      </IconButton>
      <ServeSimBrandLink />
    </div>
  );
}
