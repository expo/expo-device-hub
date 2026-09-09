import { text, textSize } from "../primitives";

export function SectionNote({
  children,
  role,
  id,
}: {
  children: string;
  role?: "alert" | "status";
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
        padding: "0 0 8px",
        color: role === "alert" ? text.danger : text.tertiary,
      }}
    >
      {children}
    </span>
  );
}
