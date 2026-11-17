import {
  Content,
  Icon as SelectIcon,
  Item,
  ItemIndicator,
  ItemText,
  Portal,
  Root,
  Trigger,
  Value,
  Viewport,
} from "@radix-ui/react-select";
import { useEffect, useRef, useState } from "react";

import {
  bg,
  border,
  icon,
  layer,
  motion,
  opacity,
  radius,
  shadow,
  text,
  textSize,
  truncate,
} from "../theme/tokens";
import { DisabledControlHint } from "./DisabledControlHint";
import { FIELD_HEIGHT, FIELD_WIDTH, fieldControlProps } from "./field";
import { CheckIcon, ChevronDownIcon } from "./icons";

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  disabled?: boolean;
  shortcut?: string;
};

export type SelectProps<Value extends string> = {
  ariaLabel: string;
  ariaDescribedBy?: string;
  value: Value;
  options: ReadonlyArray<SelectOption<Value>>;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (value: Value) => void;
  /** Re-apply an already selected action, without changing ordinary select behavior. */
  onReselect?: (value: Value) => void;
  /** Shown in place of the value while it is unknown, such as before the device reports it. */
  placeholder?: string;
  /** Width of the trigger in px. Every select of a column has the same width. */
  width?: number;
};

/** What a select shows for a value that is not known: the website's placeholder. */
export const SELECT_PLACEHOLDER = "—";

type SelectRegistration = {
  trigger: HTMLButtonElement | null;
  disabled: boolean;
  open: () => void;
};

/**
 * Every mounted select. An open Radix select disables pointer events on the
 * rest of the page, so a click on another select's trigger would only dismiss
 * the open menu. The dismissing select looks up the trigger under the pointer
 * here and opens it, so one click switches menus.
 */
const mountedSelects = new Set<SelectRegistration>();

function selectAtPoint(x: number, y: number, except: SelectRegistration) {
  for (const entry of mountedSelects) {
    if (entry === except || entry.disabled || !entry.trigger) continue;
    const rect = entry.trigger.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return entry;
  }
  return null;
}

/**
 * A compact single-value select in the look of the website's preview options:
 * a bordered box of a fixed width with the current value and a chevron. A
 * value that is longer than the box ends in an ellipsis; the open menu grows
 * to fit its widest option instead of wrapping. A value that is not one of
 * the options shows the placeholder. Clicking another select while this one
 * is open closes this menu and opens the other in the same click.
 * The offered option labels are exposed on the trigger as `data-test-options`
 * (newline-separated) so tests can read them, since the menu only renders
 * while open.
 */
export function Select<Value extends string>({
  ariaLabel,
  ariaDescribedBy,
  value,
  options,
  disabled = false,
  disabledReason,
  onChange,
  onReselect,
  placeholder = SELECT_PLACEHOLDER,
  width = FIELD_WIDTH,
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? (value || placeholder);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const field = fieldControlProps({ disabled, width });
  const pointerType = useRef("touch");
  const reselect = (option: SelectOption<Value>) => {
    if (!disabled && !option.disabled && option.value === value) onReselect?.(option.value);
  };
  const registration = useRef<SelectRegistration>({
    trigger: null,
    disabled,
    open: () => setOpen(true),
  });

  useEffect(() => {
    registration.current.disabled = disabled;
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    const entry = registration.current;
    entry.trigger = triggerRef.current;
    mountedSelects.add(entry);
    return () => {
      mountedSelects.delete(entry);
    };
  }, []);

  return (
    <Root
      value={value}
      open={open && !disabled}
      onOpenChange={(nextOpen) => setOpen(nextOpen && !disabled)}
      disabled={disabled}
      onValueChange={(nextValue) => {
        if (!disabled) onChange(nextValue as Value);
      }}
    >
      <DisabledControlHint
        reason={disabled ? disabledReason : undefined}
        label={`${ariaLabel}: ${selectedLabel}`}
      >
        <Trigger
          ref={triggerRef}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          data-test-options={options.map((option) => option.label).join("\n")}
          className={field.className}
          style={{ ...field.style, maxWidth: "100%" }}
        >
          <span
            style={{
              ...truncate,
              minWidth: 0,
              flex: 1,
              textAlign: "left",
              // The website shows a value that is not known in the quaternary color.
              color: selectedOption || value ? undefined : text.quaternary,
            }}
          >
            {/* Radix shows the placeholder, not the children, while the value is empty. */}
            <Value placeholder={placeholder}>{selectedLabel}</Value>
          </span>
          <SelectIcon
            aria-hidden="true"
            style={{
              display: "flex",
              flexShrink: 0,
              color: icon.secondary,
              transform: open ? "rotate(180deg)" : undefined,
              transition: `transform ${motion.fast} ${motion.ease}`,
            }}
          >
            <ChevronDownIcon size={16} strokeWidth={2} />
          </SelectIcon>
        </Trigger>
      </DisabledControlHint>
      <Portal>
        <Content
          position="popper"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onPointerDownOutside={(event) => {
            // With pointer events disabled on the page the event target is not
            // the trigger, so hit-test the registered trigger rects instead.
            // This assumes nothing overlaps a trigger while a menu is open,
            // which holds in the sidebar; an element covering a trigger would
            // open that select too.
            const { clientX, clientY } = event.detail.originalEvent;
            const next = selectAtPoint(clientX, clientY, registration.current);
            // Let this menu dismiss first, then open the select under the pointer.
            if (next) setTimeout(next.open, 0);
          }}
          className="will-change-[opacity,transform] data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade data-[side=right]:animate-slideLeftAndFade data-[side=top]:animate-slideDownAndFade"
          style={{
            ...textSize.sm,
            zIndex: layer.popover,
            width: "max-content",
            minWidth: "var(--radix-select-trigger-width)",
            maxWidth: "var(--radix-select-content-available-width)",
            maxHeight: "var(--radix-select-content-available-height)",
            boxSizing: "border-box",
            overflow: "hidden",
            border: `1px solid ${border.default}`,
            borderRadius: radius.lg,
            outline: "none",
            backgroundColor: bg.default,
            boxShadow: shadow.md,
            color: text.default,
            fontFamily: "inherit",
          }}
        >
          <Viewport>
            {options.map((option) => (
              <Item
                key={option.value}
                value={option.value}
                textValue={option.label}
                disabled={option.disabled}
                onPointerDown={(event) => {
                  pointerType.current = event.pointerType;
                }}
                onPointerMove={(event) => {
                  pointerType.current = event.pointerType;
                }}
                onPointerUp={() => {
                  if (pointerType.current === "mouse") reselect(option);
                }}
                onClick={() => {
                  if (pointerType.current !== "mouse") reselect(option);
                }}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    !event.repeat &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    reselect(option);
                  }
                }}
                className="data-[highlighted]:bg-element"
                style={{
                  display: "flex",
                  width: "100%",
                  minHeight: FIELD_HEIGHT,
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  boxSizing: "border-box",
                  padding: "8px 12px",
                  outline: "none",
                  color: text.default,
                  cursor: option.disabled ? "default" : "pointer",
                  opacity: option.disabled ? opacity.disabled : 1,
                  userSelect: "none",
                  whiteSpace: "nowrap",
                }}
              >
                <ItemText>{option.label}</ItemText>
                {option.shortcut && (
                  <span
                    aria-label={`Shortcut ${option.shortcut}`}
                    style={{ ...textSize.xs, color: text.tertiary }}
                  >
                    {option.shortcut}
                  </span>
                )}
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    width: 16,
                    flexShrink: 0,
                    alignItems: "center",
                    justifyContent: "center",
                    color: icon.secondary,
                  }}
                >
                  <ItemIndicator>
                    <CheckIcon size={16} />
                  </ItemIndicator>
                </span>
              </Item>
            ))}
          </Viewport>
        </Content>
      </Portal>
    </Root>
  );
}
