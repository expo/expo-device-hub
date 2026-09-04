import { text, textSize } from "../primitives";

export function SectionNote({ children, role }: { children: string; role?: "alert" | "status" }) {
  return (
    <span
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
