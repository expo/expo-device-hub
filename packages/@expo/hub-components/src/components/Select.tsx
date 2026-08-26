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

export type SelectOption<Value extends string = string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export type SelectProps<Value extends string> = {
  ariaLabel: string;
  value: Value;
  options: ReadonlyArray<SelectOption<Value>>;
  disabled?: boolean;
  onChange: (value: Value) => void;
};

/** A compact single-value select whose trigger is sized by its longest option. */
export function Select<Value extends string>({
  ariaLabel,
  value,
  options,
  disabled = false,
  onChange,
}: SelectProps<Value>) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
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
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...textSize.xs,
          display: 'inline-flex',
          width: 'max-content',
          height: 30,
          flexShrink: 0,
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          boxSizing: 'border-box',
          padding: '0 7px 0 9px',
          border: `1px solid ${border.default}`,
          borderRadius: radius.md,
          outline: 'none',
          backgroundColor: bg.subtle,
          boxShadow: focused ? `0 0 0 2px ${border.secondary}` : shadow.none,
          color: text.default,
          fontFamily: 'inherit',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
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
            color: icon.secondary,
            transform: open ? 'rotate(180deg)' : undefined,
            transition: 'transform 120ms ease',
          }}
        >
          <ChevronDownIcon size={14} />
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
            ...textSize.xs,
            zIndex: 605,
            width: 'var(--radix-select-trigger-width)',
            minWidth: 'var(--radix-select-trigger-width)',
            maxHeight: 'var(--radix-select-content-available-height)',
            boxSizing: 'border-box',
            overflow: 'hidden',
            padding: 4,
            border: `1px solid ${border.default}`,
            borderRadius: radius.md,
            outline: 'none',
            backgroundColor: bg.subtle,
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
                  height: 30,
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 4,
                  boxSizing: 'border-box',
                  padding: '0 4px',
                  borderRadius: radius.sm,
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
