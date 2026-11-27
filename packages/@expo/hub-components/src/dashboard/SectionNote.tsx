import { text, textSize, tone as tones, type Tone } from "../primitives";

/**
 * A line of small text under the controls of a sidebar section. An alert is in
 * the danger color; pass `tone` for another status color, such as a warning.
 */
export function SectionNote({
  children,
  role,
  tone = role === "alert" ? "danger" : undefined,
  id,
}: {
  children: string;
  role?: "alert" | "status";
  /** The status color of the text. An alert is `danger`; other notes have none. */
  tone?: Tone;
  /** Lets a control point `aria-describedby` at this note. */
  id?: string;
}) {
  return (
    <span
      id={id}
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
      style={{
        ...textSize.xs,
        display: "block",
        overflowWrap: "anywhere",
        padding: "0 0 8px",
        color: tone ? tones[tone].text : text.tertiary,
      }}
    >
      {children}
    </span>
  );
}
