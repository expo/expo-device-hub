export function StreamStatusPill({
  streaming,
  inputUnavailable = false,
  keyboardUnavailable = false,
}: {
  streaming: boolean;
  inputUnavailable?: boolean;
  keyboardUnavailable?: boolean;
}) {
  const color =
    inputUnavailable || keyboardUnavailable ? "#fbbf24" : streaming ? "#4ade80" : "#8e8e93";
  const label = inputUnavailable
    ? "input unavailable"
    : keyboardUnavailable
      ? "keyboard unavailable"
      : streaming
        ? "live"
        : "connecting";

  return (
    <span
      data-testid="stream-status-pill"
      title={
        inputUnavailable
          ? "Touch and keyboard input are unavailable. Restart serve-sim to retry."
          : keyboardUnavailable
            ? "Touch input remains available. Restart serve-sim to retry keyboard input."
            : undefined
      }
      className="inline-flex items-center gap-[5px] text-[12px] font-mono font-medium leading-none whitespace-nowrap"
      style={{ color }}
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-1.5 rounded-full [transition:background_0.18s_ease]"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
