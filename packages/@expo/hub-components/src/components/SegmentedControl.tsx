import { useCallback, useLayoutEffect, useRef, useState } from 'react';

import { bg, border, radius, text, textSize } from '../theme/tokens';

const CONTROL_HEIGHT = 28;
const OPTION_HEIGHT = 22;
const CONTROL_SPACING = 2;
const OPTION_HORIZONTAL_PADDING = 8;

type PillLayout = {
  left: number;
  width: number;
};

export type SegmentedControlOption<Value extends string> = {
  value: Value;
  label: string;
  disabled?: boolean;
};

export function SegmentedControl<Value extends string>({
  ariaLabel,
  ariaDescribedBy,
  compact = false,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  ariaDescribedBy?: string;
  /** Reduce horizontal padding for dense sidebar rows at the minimum panel width. */
  compact?: boolean;
  options: ReadonlyArray<SegmentedControlOption<Value>>;
  value: Value;
  onChange: (value: Value) => void;
}) {
  const selectedIndex = options.findIndex((option) => option.value === value);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pillLayout, setPillLayout] = useState<PillLayout | null>(null);

  const measureSelectedOption = useCallback(() => {
    const selectedOption = optionRefs.current[selectedIndex];

    if (!selectedOption) {
      setPillLayout(null);
      return;
    }

    const nextLayout = {
      left: selectedOption.offsetLeft,
      width: selectedOption.offsetWidth,
    };

    setPillLayout((currentLayout) =>
      currentLayout?.left === nextLayout.left && currentLayout.width === nextLayout.width
        ? currentLayout
        : nextLayout
    );
  }, [selectedIndex]);

  useLayoutEffect(() => {
    measureSelectedOption();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measureSelectedOption);
    optionRefs.current.forEach((option) => {
      if (option) observer.observe(option);
    });

    return () => observer.disconnect();
  }, [measureSelectedOption, options.length]);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      style={{
        display: 'flex',
        position: 'relative',
        flexShrink: 0,
        gap: CONTROL_SPACING,
        height: CONTROL_HEIGHT,
        padding: CONTROL_SPACING,
        boxSizing: 'border-box',
        border: `1px solid ${border.default}`,
        borderRadius: radius.full,
        backgroundColor: bg.subtle,
      }}>
      {pillLayout && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: CONTROL_SPACING,
            left: pillLayout.left,
            width: pillLayout.width,
            height: OPTION_HEIGHT,
            borderRadius: radius.full,
            backgroundColor: text.default,
            transition:
              'left 180ms cubic-bezier(.4, 0, .2, 1), width 180ms cubic-bezier(.4, 0, .2, 1)',
          }}
        />
      )}
      {options.map((option, index) => {
        const selected = value === option.value;

        return (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            disabled={option.disabled}
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            style={{
              ...textSize.xs,
              position: 'relative',
              zIndex: 1,
              width: 'auto',
              height: OPTION_HEIGHT,
              flexShrink: 0,
              boxSizing: 'border-box',
              padding: `0 ${compact ? 4 : OPTION_HORIZONTAL_PADDING}px`,
              border: 0,
              borderRadius: radius.full,
              backgroundColor: 'transparent',
              color: selected ? bg.default : text.secondary,
              fontFamily: 'inherit',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              cursor: option.disabled ? 'default' : 'pointer',
              opacity: option.disabled ? 0.5 : 1,
              transition: 'color 120ms cubic-bezier(.4, 0, .2, 1)',
            }}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
