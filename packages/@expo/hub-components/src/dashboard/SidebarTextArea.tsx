import { forwardRef, useState } from "react";

import { bg, border, font, isFocusVisible, radius, text, textSize } from "../primitives";

/** A multi-line monospace field for text sent to or read from the device. */
export const SidebarTextArea = forwardRef<
  HTMLTextAreaElement,
  {
    ariaLabel: string;
    placeholder?: string;
    value: string;
    readOnly?: boolean;
    disabled?: boolean;
    onChange?: (value: string) => void;
    /** Command+Enter or Control+Enter in the field. */
    onSubmit?: () => void;
  }
>(function SidebarTextArea(
  { ariaLabel, placeholder, value, readOnly = false, disabled = false, onChange, onSubmit },
  ref,
) {
  const [focused, setFocused] = useState(false);

  return (
    <textarea
      ref={ref}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      readOnly={readOnly}
      disabled={disabled}
      rows={3}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange?.(event.currentTarget.value)}
      onFocus={(event) => setFocused(isFocusVisible(event))}
      onBlur={() => setFocused(false)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit?.();
      }}
      style={{
        ...textSize.sm,
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        padding: "6px 10px",
        border: `1px solid ${border.default}`,
        borderRadius: radius.lg,
        outline: "none",
        backgroundColor: bg.element,
        boxShadow: focused ? `0 0 0 2px ${border.secondary}` : "none",
        color: text.default,
        caretColor: text.default,
        fontFamily: font.mono,
        resize: "vertical",
      }}
    />
  );
});
