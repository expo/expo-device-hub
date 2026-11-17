import { type DeviceClient } from "@expo/hub-client";
import type { ScreenCorner, ScreenShape } from "@expo/hub-client/shapes";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { type CSSProperties, useState } from "react";

import { LOADING_LABEL, PhoneIcon, bg, icon, screenOff, text, textSize } from "../primitives";
import { useLingering } from "./useLingering";

// The two times are also in `theme.css`, as `--hub-screen-live-fade` and
// `--hub-screen-stage-exit`; keep both in step.
/** How long the live picture takes to fade in over the stage that it replaces, as on the website. */
const LIVE_FADE_MS = 550;
/** How long a stage layer takes to fade out, after the live picture covers it. */
const STAGE_EXIT_MS = 650;
/** How long a stage layer stays after the first frame: under the picture that fades in, and then for its own exit. */
const STAGE_LINGER_MS = LIVE_FADE_MS + STAGE_EXIT_MS;

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
 * The layer under the stream of a flat device screen: one per stage, and
 * opaque, so the page never shows through the screen. The `live` stage has no
 * layer of its own, because a solid layer under a presented stream shows as a
 * thin line along the clipped edge of the screen. The layer of the stage
 * before it stays until the live picture has faded in.
 */
// @ref LLP 0015#stages — a stage layer stays opaque until the live picture has faded in above it
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
  const live = stage === "live";
  // The stage that the screen leaves for the live picture, with what it showed. Its layer
  // stays opaque under the picture while that fades in, and then fades out.
  const [last, setLast] = useState({ stage, error });
  if (!live && (stage !== last.stage || error !== last.error)) setLast({ stage, error });
  // With reduced motion nothing fades, and the layer goes after the same time.
  const shown = useLingering(!live, STAGE_LINGER_MS);
  if (!shown) return null;

  const layer = live ? last : { stage, error };
  // A layer that leaves says nothing: its state is over.
  const leaving = live ? { "data-leaving": "true", "aria-hidden": true } : null;
  const testId = (id: string) => (live ? "device-screen-stage-leaving" : id);

  if (layer.stage === "connecting") {
    return (
      <div
        className="hub-screen-stage hub-screen-glow"
        data-testid={testId("device-screen-loading")}
        role={live ? undefined : "status"}
        {...leaving}
        style={
          {
            ...LAYER_STYLE,
            borderRadius,
            // 1% of the screen's short side: the unit of the glow's lengths.
            "--hub-screen-unit": `${(1 / Math.max(ratio, 1)).toFixed(4)}cqw`,
          } as CSSProperties
        }
      >
        {!live && <VisuallyHidden>{LOADING_LABEL}</VisuallyHidden>}
      </div>
    );
  }
  if (layer.stage === "unavailable") {
    return (
      <div
        className="hub-screen-stage"
        data-testid={testId("device-screen-unavailable")}
        {...leaving}
        style={UNAVAILABLE_STYLE}
      >
        <PhoneIcon size={32} color={icon.secondary} />
        <div role={live ? undefined : "alert"}>
          <p style={{ ...textSize.sm, fontWeight: 600, color: text.default, margin: 0 }}>
            Device screen unavailable
          </p>
          <p style={{ ...textSize.sm, color: text.secondary, margin: "8px 0 0" }}>{layer.error}</p>
        </div>
      </div>
    );
  }
  return (
    <div
      className="hub-screen-stage"
      data-testid={testId("device-screen-surface")}
      {...leaving}
      style={{ ...LAYER_STYLE, backgroundColor: screenOff }}
    />
  );
}
