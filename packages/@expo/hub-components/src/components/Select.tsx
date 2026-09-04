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
} from '@radix-ui/react-select';
import { useEffect, useRef, useState } from 'react';

import { bg, border, icon, radius, shadow, text, textSize } from '../theme/tokens';
import { CheckIcon, ChevronDownIcon } from './icons';
import { isFocusVisible } from './focusVisible';
import { pillControlStyle } from './pill';

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export type SelectProps<Value extends string> = {
  ariaLabel: string;
  ariaDescribedBy?: string;
  value: Value;
  options: ReadonlyArray<SelectOption<Value>>;
  disabled?: boolean;
  onChange: (value: Value) => void;
};

const ITEM_HEIGHT = 28;

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
 * A compact single-value select rendered as a soft pill: the current value
 * followed by a chevron. The closed trigger is only as wide as the selected
 * value; the open menu grows to fit its widest option instead of wrapping.
 * Clicking another select while this one is open closes this menu and opens
 * the other in the same click.
 * The offered option labels are exposed on the trigger as `data-options`
 * (newline-separated) for tooling and tests, since the menu only renders
 * while open.
 */
export function Select<Value extends string>({
  ariaLabel,
  ariaDescribedBy,
  value,
  options,
  disabled = false,
  onChange,
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const registration = useRef<SelectRegistration>({
    trigger: null,
    disabled,
    open: () => setOpen(true),
  });
  registration.current.disabled = disabled;

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
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      onValueChange={(nextValue) => onChange(nextValue as Value)}
    >
      <Trigger
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        data-options={options.map((option) => option.label).join('\n')}
        onFocus={(event) => setFocused(isFocusVisible(event))}
        onBlur={() => setFocused(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...pillControlStyle({ hovered, focused, disabled }),
          width: 'max-content',
          maxWidth: '100%',
          justifyContent: 'space-between',
          padding: '0 8px 0 10px',
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <Value>{selectedLabel}</Value>
        </span>
        <SelectIcon
          aria-hidden="true"
          style={{
            display: 'flex',
            flexShrink: 0,
            color: icon.default,
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform 120ms ease',
          }}
        >
          <ChevronDownIcon size={16} strokeWidth={1.5} />
        </SelectIcon>
      </Trigger>
      <Portal>
        <Content
          position="popper"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onPointerDownOutside={(event) => {
            const { clientX, clientY } = event.detail.originalEvent;
            const next = selectAtPoint(clientX, clientY, registration.current);
            // Let this menu dismiss first, then open the select under the pointer.
            if (next) setTimeout(next.open, 0);
          }}
          className="will-change-[opacity,transform] data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade data-[side=right]:animate-slideLeftAndFade data-[side=top]:animate-slideDownAndFade"
          style={{
            ...textSize.sm,
            fontWeight: 500,
            zIndex: 605,
            width: 'max-content',
            minWidth: 'var(--radix-select-trigger-width)',
            maxWidth: 'var(--radix-select-content-available-width)',
            maxHeight: 'var(--radix-select-content-available-height)',
            boxSizing: 'border-box',
            overflow: 'hidden',
            padding: 4,
            border: `1px solid ${border.default}`,
            borderRadius: radius.lg,
            outline: 'none',
            backgroundColor: bg.default,
            boxShadow: shadow.md,
            color: text.default,
            fontFamily: 'inherit',
          }}
        >
          <Viewport>
            {options.map((option) => (
              <Item
                key={option.value}
                value={option.value}
                textValue={option.label}
                disabled={option.disabled}
                className="data-[highlighted]:bg-hover data-[state=checked]:bg-element"
                style={{
                  display: 'flex',
                  width: '100%',
                  height: ITEM_HEIGHT,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  boxSizing: 'border-box',
                  padding: '0 6px',
                  borderRadius: radius.md,
                  outline: 'none',
                  color: text.default,
                  cursor: option.disabled ? 'default' : 'pointer',
                  opacity: option.disabled ? 0.5 : 1,
                  userSelect: 'none',
                  whiteSpace: 'nowrap',
                }}
              >
                <ItemText>{option.label}</ItemText>
                <span
                  aria-hidden="true"
                  style={{
                    display: 'flex',
                    width: 14,
                    flexShrink: 0,
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: icon.default,
                  }}
                >
                  <ItemIndicator>
                    <CheckIcon size={12} />
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
