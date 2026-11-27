import { type ReactNode } from "react";

import { text, textSize } from "../primitives";

/**
 * A label on the left and its control on the right, like an option of the
 * website's preview settings. Rows stack without dividers: their vertical
 * padding gives the website's 20px between two rows.
 */
export function SidebarRow({
  label,
  children,
  description,
  descriptionId,
}: {
  label: string;
  children: ReactNode;
  /** Optional explanatory copy shown directly beneath the label. */
  description?: string;
  /** Associates the explanatory copy with an interactive row control. */
  descriptionId?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        boxSizing: "border-box",
        padding: "10px 0",
      }}
    >
      <span style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column", gap: 2 }}>
        <span
          style={{
            ...textSize.sm,
            fontWeight: 500,
            color: text.secondary,
            overflowWrap: "anywhere",
          }}
        >
          {label}
        </span>
        {description && (
          <span id={descriptionId} style={{ ...textSize.xs, color: text.tertiary }}>
            {description}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}
