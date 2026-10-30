import { useState } from "react";
import { Button } from "../components/Button";
import type { AddDeviceOutcome } from "./data";
import { PhoneIcon, bg, border, heading, icon, radius, text, textSize } from "../primitives";
import { type Platform } from "./data";

/**
 * Shown in the stream panel when no devices are available — i.e. there are no
 * booted simulators, emulators, or connected physical devices to mirror. Points
 * the user at the sidebar's + buttons to boot one.
 */
export function EmptyState({
  platform,
  framed = true,
  singleDevice = false,
  onStart,
}: {
  platform?: Platform;
  singleDevice?: boolean;
  onStart?: () => Promise<AddDeviceOutcome>;
  /** Whether to draw the hairline seams toward the sidebars (see StreamPanel). */
  framed?: boolean;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    if (!onStart || starting) return;
    setStarting(true);
    setError(null);
    try {
      const result = await onStart();
      if (!result.ok) setError(result.error ?? "The device did not come online.");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }
  const title = singleDevice
    ? "The session device is unavailable"
    : platform === "ios"
      ? "No booted simulators"
      : platform === "android"
        ? "No booted emulators"
        : "No booted devices";
  const description = singleDevice
    ? onStart
      ? "Start the same device to continue."
      : "Reconnect the same device to continue."
    : platform === "ios"
      ? "There are no booted simulators. Use the + button to add one."
      : platform === "android"
        ? "There are no booted emulators or connected devices. Use the + button to add one."
        : "There are no booted simulators, emulators, or connected devices. Use the + button to add a simulator or emulator.";

  return (
    <section
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 40,
        boxSizing: "border-box",
        // Match StreamPanel: the gray canvas between the white sidebars.
        backgroundColor: bg.subtle,
        borderLeft: framed ? `1px solid ${border.default}` : "none",
        borderRight: framed ? `1px solid ${border.default}` : "none",
        overflow: "hidden",
        textAlign: "center",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: radius.full,
          border: `1px solid ${border.secondary}`,
          backgroundColor: bg.default,
        }}
      >
        <PhoneIcon size={28} color={icon.secondary} />
      </div>
      <h2 style={{ ...heading.lg, color: text.default, margin: 0 }}>{title}</h2>
      <p style={{ ...textSize.sm, color: text.secondary, margin: 0, maxWidth: 320 }}>
        {description}
      </p>
      {onStart && (
        <Button onClick={() => void start()} disabled={starting}>
          {starting ? "Starting…" : "Start device"}
        </Button>
      )}
      {error && (
        <p role="alert" style={{ ...textSize.sm, color: text.danger, margin: 0 }}>
          {error}
        </p>
      )}
    </section>
  );
}
