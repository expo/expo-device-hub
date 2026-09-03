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
import { useState } from 'react';

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

/**
 * A compact single-value select rendered as a soft pill: the current value
 * followed by a chevron. The trigger is sized by its longest option so it
 * never jumps as the value changes.
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

  return (
    <Root
      value={value}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      onValueChange={(nextValue) => onChange(nextValue as Value)}
    >
      <Trigger
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onFocus={(event) => setFocused(isFocusVisible(event))}
        onBlur={() => setFocused(false)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...pillControlStyle({ hovered, focused, disabled }),
          width: 'max-content',
          justifyContent: 'space-between',
          padding: '0 8px 0 10px',
        }}
      >
        <span
          style={{
            display: 'inline-grid',
            minWidth: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <Value>{selectedLabel}</Value>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-grid',
              gridArea: '2 / 1',
              height: 0,
              overflow: 'hidden',
              visibility: 'hidden',
            }}
          >
            {options.map((option) => (
              <span key={option.value} style={{ gridArea: '1 / 1' }}>
                {option.label}
              </span>
            ))}
          </span>
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
          className="will-change-[opacity,transform] data-[side=bottom]:animate-slideUpAndFade data-[side=left]:animate-slideRightAndFade data-[side=right]:animate-slideLeftAndFade data-[side=top]:animate-slideDownAndFade"
          style={{
            ...textSize.sm,
            zIndex: 605,
            width: 'var(--radix-select-trigger-width)',
            minWidth: 'var(--radix-select-trigger-width)',
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
