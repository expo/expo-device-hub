import { forwardRef } from "react";

import { fieldControlProps, font, text } from "../primitives";

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
  const field = fieldControlProps({ disabled, interactive: false });

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
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onSubmit?.();
      }}
      className={field.className}
      style={{
        ...field.style,
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        padding: "6px 10px",
        height: "auto",
        cursor: disabled ? "default" : "text",
        caretColor: text.default,
        fontFamily: font.mono,
        resize: "vertical",
      }}
    />
  );
});
