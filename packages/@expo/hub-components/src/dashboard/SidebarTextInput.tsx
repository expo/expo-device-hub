import { bg, border, font, pillControlProps, pressableStyle, text } from "../primitives";

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
  // A text field shows the focus ring for every focus and does not scale while pressed.
  const pill = pillControlProps({ disabled, pressScale: 1 });

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
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
      }}
      className={pill.className}
      style={{
        ...pill.style,
        // The field keeps one fill; only buttons and selects react to the pointer.
        ...pressableStyle({ background: bg.element, pressScale: 1 }),
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
