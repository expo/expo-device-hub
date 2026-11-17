import { type DeviceClient } from "@expo/hub-client";
import type { ScreenCorner, ScreenShape } from "@expo/hub-client/shapes";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { type CSSProperties } from "react";

import { LOADING_LABEL, PhoneIcon, bg, icon, screenOff, text, textSize } from "../primitives";
import { useLingering } from "./useLingering";

// The two times are also in `theme.css`, as `--hub-screen-live-fade` and
// `--hub-screen-glow-exit`; keep both in step.
/** How long the live picture takes to fade in over the stage that it replaces, as on the website. */
const LIVE_FADE_MS = 550;
/** How long the glow takes to fade out, after the live picture covers it. */
const GLOW_EXIT_MS = 650;
/** How long the glow stays after the first frame: under the picture that fades in, and then for its own exit. */
const GLOW_LINGER_MS = LIVE_FADE_MS + GLOW_EXIT_MS;

/**
 * What the flat device screen shows:
 *
 * - `off`: no session. The screen is black, like a device that is off.
 * - `connecting`: the session has no frame yet. A glow moves around the black screen.
 * - `live`: the session presented a frame. The stream shows, or its last frame.
 * - `unavailable`: the session failed before its first frame. The screen says why.
 */
export type DeviceScreenStage = "off" | "connecting" | "live" | "unavailable";

// @ref LLP 0015#states — a stage follows the session's first frame; a loaded screen never returns to the glow
/** The stage of a device screen. Without a client, or while it is idle, the screen is off. */
export function deviceScreenStage(
  client: Pick<DeviceClient, "status" | "framePresented"> | null | undefined,
): DeviceScreenStage {
  if (!client || client.status === "idle") return "off";
  if (client.framePresented) return "live";
  return client.status === "error" ? "unavailable" : "connecting";
}

/**
 * The radius of the circle that is closest to a superellipse corner: both pass
 * through the same point on the corner's diagonal.
 */
function cornerRadius(corner: ScreenCorner): number {
  return (corner.size * (1 - 2 ** (-1 / corner.n))) / (1 - Math.SQRT1_2);
}

/**
 * The CSS `border-radius` that follows a screen shape, for a layer that draws
 * along the screen's edge, such as the glow. The clip of `DeviceShape` still
 * gives the screen its exact outline. `cqw` resolves against the frame's width.
 */
export function screenShapeBorderRadius(shape: ScreenShape): string {
  return [shape.topLeft, shape.topRight, shape.bottomRight, shape.bottomLeft]
    .map((corner) => `${((cornerRadius(corner) / shape.width) * 100).toFixed(3)}cqw`)
    .join(" ");
}

const LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
};

const UNAVAILABLE_STYLE: CSSProperties = {
  ...LAYER_STYLE,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  padding: "0 24px",
  boxSizing: "border-box",
  textAlign: "center",
  backgroundColor: bg.element,
};

/**
 * The layers under the stream of a flat device screen, one per stage. They are
 * opaque, so the page never shows through the screen. The `live` stage has no
 * layer: a solid layer under a presented stream shows as a thin line along the
 * clipped edge of the screen.
 */
// @ref LLP 0015#stages — the glow stays opaque until the live picture has faded in above it
export function DeviceScreenStageLayers({
  stage,
  error,
  ratio,
  borderRadius,
}: {
  stage: DeviceScreenStage;
  /** The connection's error, shown by the `unavailable` stage. */
  error: string | null;
  /** The screen's width divided by its height, so that a sideways screen glows as wide as an upright one. */
  ratio: number;
  /** The corners of the screen, so that the glow follows them. */
  borderRadius?: string;
}) {
  const connecting = stage === "connecting";
  // With reduced motion the glow does not fade, and it goes after the same time.
  const glow = useLingering(connecting, GLOW_LINGER_MS);

  return (
    <>
      {stage === "off" && (
        <div
          data-testid="device-screen-surface"
          style={{ ...LAYER_STYLE, backgroundColor: screenOff }}
        />
      )}
      {glow && (
        <div
          className="hub-screen-glow"
          data-testid={connecting ? "device-screen-loading" : "device-screen-glow-leaving"}
          data-leaving={connecting ? undefined : "true"}
          role={connecting ? "status" : undefined}
          aria-hidden={connecting ? undefined : true}
          style={
            {
              ...LAYER_STYLE,
              borderRadius,
              // 1% of the screen's short side: the unit of the glow's lengths.
              "--hub-screen-unit": `${(1 / Math.max(ratio, 1)).toFixed(4)}cqw`,
            } as CSSProperties
          }
        >
          {connecting && <VisuallyHidden>{LOADING_LABEL}</VisuallyHidden>}
        </div>
      )}
      {stage === "unavailable" && (
        <div
          className="hub-screen-unavailable"
          data-testid="device-screen-unavailable"
          style={UNAVAILABLE_STYLE}
        >
          <PhoneIcon size={32} color={icon.secondary} />
          <div role="alert">
            <p style={{ ...textSize.sm, fontWeight: 600, color: text.default, margin: 0 }}>
              Device screen unavailable
            </p>
            <p style={{ ...textSize.sm, color: text.secondary, margin: "8px 0 0" }}>{error}</p>
          </div>
        </div>
      )}
    </>
  );
}
