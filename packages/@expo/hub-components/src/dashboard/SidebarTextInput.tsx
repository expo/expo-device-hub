import { useState } from "react";

import { border, font, isFocusVisible, pillControlStyle, text } from "../primitives";

const INPUT_WIDTH = 128;

/**
 * A compact single-line field wearing the same pill as the select triggers it
 * sits beside on a sidebar row. `type="text"` rather than `number`: number
 * inputs add spinners, change value on wheel, and reject a lone `-` mid-type.
 */
export function SidebarTextInput({
  ariaLabel,
  value,
  disabled = false,
  invalid = false,
  describedBy,
  onChange,
  onSubmit,
  onPasteText,
}: {
  ariaLabel: string;
  value: string;
  disabled?: boolean;
  /** Marks the field the last parse rejected. */
  invalid?: boolean;
  /** Element holding the message for that rejection. */
  describedBy?: string;
  onChange: (value: string) => void;
  /** Enter in the field. */
  onSubmit: () => void;
  /** Offered the pasted text; return true to consume it instead of inserting it. */
  onPasteText?: (text: string) => boolean;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      value={value}
      disabled={disabled}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.currentTarget.value)}
      onPaste={(event) => {
        if (onPasteText?.(event.clipboardData.getData("text"))) event.preventDefault();
      }}
      onFocus={(event) => setFocused(isFocusVisible(event))}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      style={{
        ...pillControlStyle({ focused, disabled }),
        display: "inline-block",
        width: INPUT_WIDTH,
        border: `1px solid ${invalid ? border.danger : border.default}`,
        textAlign: "right",
        fontFamily: font.mono,
        caretColor: text.default,
        cursor: disabled ? "default" : "text",
      }}
    />
  );
}
