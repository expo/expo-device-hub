import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

// Native option popups are drawn by the host browser and ignore the page color
// scheme in embedded webviews (Codex, VS Code), so the popup is plain DOM.
// Portaled to <body> with fixed positioning because the tools panel scrolls
// and the collapsible sections clip overflow.
export function Dropdown({
  label,
  trigger,
  disabled,
  className,
  multiple,
  closeOnSelect,
  children,
}: {
  label: string;
  trigger: ReactNode;
  disabled?: boolean;
  className?: string;
  multiple?: boolean;
  closeOnSelect?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = { top: rect.bottom + 4, left: rect.left, minWidth: rect.width };
    setPos((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.minWidth === next.minWidth
        ? prev
        : next
    );
  };

  useLayoutEffect(() => {
    if (open) place();
  }, [open]);

  // Second pass once the popup has a size: keep it inside the viewport. The settings triggers sit
  // near the panel's right edge and the option list is wider than the trigger, and the last few
  // triggers sit near the bottom of the window, where a downward list would open off screen.
  useLayoutEffect(() => {
    if (!open || !pos) return;
    const popup = popupRef.current;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!popup || !rect) return;
    const margin = 8;
    const maxLeft = window.innerWidth - popup.offsetWidth - margin;
    const left = pos.left > maxLeft ? Math.max(margin, maxLeft) : pos.left;
    const above = rect.top - popup.offsetHeight - 4;
    const top = pos.top + popup.offsetHeight <= window.innerHeight - margin
      ? pos.top
      : above >= margin
        ? above
        : Math.max(margin, window.innerHeight - popup.offsetHeight - margin);
    if (top !== pos.top || left !== pos.left) setPos({ ...pos, top, left });
  }, [open, pos]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popupRef.current?.contains(t) && !triggerRef.current?.contains(t)) close();
    };
    // Capture-phase so scrolls inside the tools panel (which don't bubble to
    // window) keep the popup glued to its trigger. Repositioning rather than
    // dismissing matters because focusing the trigger can itself scroll it
    // into view, which would otherwise close the popup as it opens.
    const onScroll = (e: Event) => {
      if (!popupRef.current?.contains(e.target as Node)) place();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  // Focus the selected option once per open — keyed off `pos` because the
  // popup only exists after placement, but guarded so scroll repositions
  // don't yank focus back from arrow-key navigation.
  const focusedThisOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedThisOpen.current = false;
      return;
    }
    if (!pos || focusedThisOpen.current) return;
    const items = [...(popupRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    if (!items.length) return;
    focusedThisOpen.current = true;
    const selected = multiple
      ? -1
      : items.findIndex((item) => item.getAttribute("aria-selected") === "true");
    items[Math.max(selected, 0)]?.focus();
  }, [open, pos, multiple]);

  const onPopupKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(popupRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? [])];
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items[next]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };


  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`text-left font-[inherit] cursor-pointer disabled:cursor-default ${className ?? ""}`}
      >
        <span className="block truncate">{trigger}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple}
            onKeyDown={onPopupKeyDown}
            onBlur={(e) => {
              // Safari leaves relatedTarget null on a click, which is not a move out.
              const next = e.relatedTarget;
              if (!(next instanceof Node)) return;
              if (popupRef.current?.contains(next) || triggerRef.current?.contains(next)) return;
              setOpen(false);
            }}
            onClick={(e) => {
              if (!closeOnSelect) return;
              if (!(e.target as Element).closest("[role=option]")) return;
              setOpen(false);
              triggerRef.current?.focus();
            }}
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
            className="fixed max-h-90 overflow-y-auto bg-panel border border-white/12 rounded-[10px] p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)] text-[12px] text-white/90 z-50"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function DropdownOption({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={(e) => {
        e.currentTarget.focus();
        onClick();
      }}
      className={`block w-full text-left font-[inherit] px-2.5 py-1 rounded-md cursor-pointer whitespace-nowrap transition-colors hover:bg-white/8 focus-visible:bg-white/8 outline-none ${selected ? "text-accent" : ""}`}
    >
      {children}
    </button>
  );
}

// Custom <select> replacement in the device-picker dropdown style.
export function Select({
  label,
  value,
  options,
  disabled,
  onChange,
  className,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (next: string) => void;
  className?: string;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Dropdown
      label={label}
      trigger={selected?.label ?? value}
      disabled={disabled}
      className={className}
      closeOnSelect
    >
      {options.map((o) => (
        <DropdownOption
          key={o.value}
          selected={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </DropdownOption>
      ))}
    </Dropdown>
  );
}
