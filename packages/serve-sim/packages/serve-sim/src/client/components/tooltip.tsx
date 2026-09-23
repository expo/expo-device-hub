import type { ReactNode } from "react";

export function Tooltip({
  label,
  align = "center",
  children,
}: {
  label: string;
  align?: "center" | "right";
  children: ReactNode;
}) {
  return (
    <span className="group relative flex items-center">
      {children}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-[calc(100%+6px)] z-50 w-max max-w-[220px] rounded-md border border-white/12 bg-panel-bg px-2 py-1 text-[11px] leading-snug text-white/90 opacity-0 shadow-[0_4px_14px_rgba(0,0,0,0.32)] transition-opacity duration-100 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 group-has-[[aria-expanded=true]]:opacity-0 ${
          align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
        }`}
      >
        {label}
      </span>
    </span>
  );
}
