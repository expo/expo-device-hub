import { border, fieldControlProps, font, text } from "../primitives";

/**
 * A compact single-line field with the same box as the select triggers it
 * sits beside on a sidebar row. `type="text"` rather than `number`: number
 * inputs add spinners, change value on wheel, and reject a lone `-` mid-type.
 */
export function SidebarTextInput({
  ariaLabel,
  value,
  placeholder,
  inputMode = "decimal",
  disabled = false,
  invalid = false,
  describedBy,
  onChange,
  onSubmit,
  onPasteText,
}: {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  /** Coordinates by default; `text` for names. */
  inputMode?: "decimal" | "text";
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
  // A text field shows the focus ring for every focus, and its fill does not follow the pointer.
  const field = fieldControlProps({ disabled, interactive: false });

  return (
    <input
      type="text"
      inputMode={inputMode}
      placeholder={placeholder}
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
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      className={field.className}
      style={{
        ...field.style,
        display: "inline-block",
        border: `1px solid ${invalid ? border.danger : border.default}`,
        textAlign: "right",
        fontFamily: font.mono,
        caretColor: text.default,
        cursor: disabled ? "default" : "text",
      }}
    />
  );
}
