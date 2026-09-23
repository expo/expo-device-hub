import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";

export interface ActionMenuItem {
  label: string;
  description?: string;
  onSelect: () => void;
}

export interface ActionMenuTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref: Ref<HTMLButtonElement>;
}

const MENU_GAP = 8;

// Portaled to <body> with fixed positioning for the same reason the device
// picker is: the actions pill clips overflow, and it sits at the bottom of the
// viewport, so the menu has to escape it and open upward.
export function ActionMenu({
  items,
  children,
}: {
  items: ActionMenuItem[];
  children: (trigger: ActionMenuTriggerProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPos({ bottom: window.innerHeight - rect.top + MENU_GAP, left: rect.left + rect.width / 2 });
  }, [open]);

  // The popup only renders once its position is measured, so wait for that render.
  useEffect(() => {
    if (!open || !pos) return;
    itemRefs.current[0]?.focus();
  }, [open, pos]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      {children({
        ref: triggerRef,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        onClick: (event) => {
          event.preventDefault();
          setOpen((wasOpen) => !wasOpen);
        },
      })}
      {open && pos
        ? createPortal(
            <div
              ref={popupRef}
              role="menu"
              aria-orientation="vertical"
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const buttons = itemRefs.current.filter((node): node is HTMLButtonElement => node != null);
                if (buttons.length === 0) return;
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const step = event.key === "ArrowDown" ? 1 : -1;
                buttons[(at + step + buttons.length) % buttons.length]?.focus();
              }}
              data-testid="action-menu"
              className="fixed z-50 -translate-x-1/2 min-w-[196px] p-1 bg-panel border border-white/12 rounded-lg shadow-[0_8px_24px_rgba(0,0,0,0.45)] text-white/90 text-[12px] font-mono"
              style={{ bottom: pos.bottom, left: pos.left }}
            >
              {items.map((item, index) => (
                <button
                  key={item.label}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  className="block w-full text-left px-2 py-2 rounded hover:bg-white/10 active:bg-white/15"
                  onClick={() => {
                    close(true);
                    item.onSelect();
                  }}
                >
                  <span className="block">{item.label}</span>
                  {item.description ? (
                    <span className="block text-white/50 text-[11px]">{item.description}</span>
                  ) : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
