import { bg, border, font, radius, text, textSize } from "../primitives";

/** An emulator that renders on the CPU, on a host that could render it on the GPU. */
export type GpuWarningInfo = {
  /** The software renderer, such as `"SwiftShader"`. */
  renderer: string;
};

export const GPU_WARNING_TITLE = "This emulator does not use the GPU";

/**
 * Tells the user to restart a software-rendered emulator with `-gpu host`. The
 * consumer shows it only on a host where `-gpu host` is expected to work.
 */
// @ref LLP 0024#warning — a recommendation only; the Hub does not restart the emulator
export function GpuWarning({ renderer }: GpuWarningInfo) {
  const flag = <code style={{ fontFamily: font.mono, whiteSpace: "nowrap" }}>-gpu host</code>;
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        margin: "8px 0",
        padding: "8px 12px",
        borderRadius: radius.lg,
        border: `1px solid ${border.warning}`,
        backgroundColor: bg.warning,
      }}
    >
      <span style={{ ...textSize.sm, fontWeight: 500, color: text.warning }}>
        {GPU_WARNING_TITLE}
      </span>
      <span style={{ ...textSize.xs, color: text.secondary }}>
        It renders with {renderer} on the CPU, which is slower. Restart it with {flag} to use this
        Mac&apos;s GPU. The Hub boots emulators on this Mac with {flag}.
      </span>
    </div>
  );
}
