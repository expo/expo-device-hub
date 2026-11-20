import { type DevicePlayback } from "@expo/hub-client";

import { bg, Button, radius, shadow, text, textSize } from "../primitives";

// @ref LLP 0015#where-each-part-lives — recovery notices belong outside the renderer's hidden media
export function PlaybackRecovery({
  playback,
  overModel = false,
}: {
  playback: DevicePlayback;
  overModel?: boolean;
}) {
  return (
    <div
      data-testid="playback-recovery"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        backgroundColor: overModel ? "transparent" : bg.element,
        boxSizing: "border-box",
        color: text.default,
        textAlign: "center",
        ...textSize.sm,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          ...(overModel && {
            maxWidth: 320,
            padding: 24,
            backgroundColor: bg.element,
            borderRadius: radius.xl,
            boxShadow: shadow.lg,
          }),
        }}
      >
        <div role="status">
          {playback.state === "blocked"
            ? "Playback is paused in this browser."
            : (playback.error ?? "Live video could not start.")}
        </div>
        <Button
          onClick={() => {
            void playback.resume();
          }}
        >
          {playback.state === "blocked" ? "Start live view" : "Retry live view"}
        </Button>
      </div>
    </div>
  );
}
